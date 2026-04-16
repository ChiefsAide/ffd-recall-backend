const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Strip trailing slash from BACKEND_URL to prevent double-slash URLs
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/$/, '');

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
const activeCalls = {};

// ── FIREBASE ADMIN INIT ───────────────────────────────────────
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id
    });
    console.log('Firebase Admin initialized:', serviceAccount.project_id);
  } catch (err) {
    console.error('Firebase Admin init error:', err.message);
  }
}

function getDb() {
  try { return admin.firestore(); } catch(e) { return null; }
}

// ── PLACE CALL ────────────────────────────────────────────────
app.post('/place-call', async (req, res) => {
  const { to, name, memberId, sessionId } = req.body;
  if (!to || !name) return res.status(400).json({ error: 'Missing to or name' });

  let phone = to.replace(/\D/g, '');
  if (phone.length === 10) phone = '1' + phone;
  if (!phone.startsWith('+')) phone = '+' + phone;

  const voiceUrl = BACKEND_URL + '/voice'
    + '?name=' + encodeURIComponent(name)
    + '&memberId=' + encodeURIComponent(memberId || '')
    + '&sessionId=' + encodeURIComponent(sessionId || '');

  console.log('Placing call to', name, phone);
  console.log('Voice URL:', voiceUrl);

  try {
    const call = await client.calls.create({
      to: phone,
      from: FROM_NUMBER,
      url: voiceUrl,
      statusCallback: BACKEND_URL + '/call-status',
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed', 'no-answer', 'busy', 'failed'],
      timeout: 30,
      machineDetection: 'Enable'
    });
    activeCalls[call.sid] = { memberId, sessionId, name, phone };
    console.log('Call SID:', call.sid);
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('Call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── VOICE (what plays when answered) ─────────────────────────
app.all('/voice', function(req, res) {
  try {
    var name      = (req.query.name      || 'Member').trim();
    var memberId  = (req.query.memberId  || '').trim();
    var sessionId = (req.query.sessionId || '').trim();

    console.log('Voice endpoint hit — name:', name, 'AnsweredBy:', req.body.AnsweredBy);

    // Voicemail / answering machine
    var answeredBy = (req.body && req.body.AnsweredBy) || req.query.AnsweredBy || '';
    if (answeredBy === 'machine_start' || answeredBy === 'fax') {
      return res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response>' +
        '<Say voice="Polly.Matthew" language="en-US">' +
        'This is Fairview Fire Department. ' + name + ', you have been selected for a recall. ' +
        'Please call back or check the Chiefs Aide app.' +
        '</Say>' +
        '</Response>'
      );
    }

    var actionUrl = BACKEND_URL + '/keypress'
      + '?memberId=' + encodeURIComponent(memberId)
      + '&sessionId=' + encodeURIComponent(sessionId)
      + '&name=' + encodeURIComponent(name);

    console.log('Keypress action URL:', actionUrl);

    var twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response>' +
      '<Gather numDigits="1" action="' + actionUrl + '" method="POST" timeout="15">' +
      '<Say voice="Polly.Matthew" language="en-US">' +
      'Fairview Fire Department recall. ' +
      name + ', you are being recalled. ' +
      'Press 1 if you are coming in. ' +
      'Press 2 if you are not coming in.' +
      '</Say>' +
      '<Say voice="Polly.Matthew" language="en-US">' +
      'Press 1 if you are coming in. ' +
      'Press 2 if you are not coming in.' +
      '</Say>' +
      '</Gather>' +
      '<Say voice="Polly.Matthew" language="en-US">' +
      'We did not receive a response. Please call back or check the Chiefs Aide app. Goodbye.' +
      '</Say>' +
      '</Response>';

    res.type('text/xml').send(twiml);

  } catch (err) {
    console.error('Voice endpoint error:', err.message);
    res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response><Say>We encountered an error. Please call back. Goodbye.</Say></Response>'
    );
  }
});

// ── KEYPRESS (1=yes, 2=no) ────────────────────────────────────
app.all('/keypress', function(req, res) {
  try {
    var digit     = (req.body && req.body.Digits) || req.query.Digits || '';
    var memberId  = (req.query.memberId  || '').trim();
    var sessionId = (req.query.sessionId || '').trim();
    var name      = (req.query.name      || 'Member').trim();
    var responding = digit === '1';

    console.log('Keypress:', name, 'pressed', digit, responding ? 'COMING IN' : 'NOT COMING IN');
    notifyApp({ memberId, sessionId, responding, name });

    res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response>' +
      '<Say voice="Polly.Matthew" language="en-US">' +
      (responding
        ? 'Thank you ' + name + '. You are marked as responding. Please respond safely. Goodbye.'
        : 'Thank you ' + name + '. You are marked as not responding. Goodbye.'
      ) +
      '</Say>' +
      '</Response>'
    );
  } catch (err) {
    console.error('Keypress error:', err.message);
    res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response><Say>Response recorded. Goodbye.</Say></Response>'
    );
  }
});

// ── CALL STATUS CALLBACK ──────────────────────────────────────
app.all('/call-status', function(req, res) {
  try {
    var CallSid    = req.body.CallSid    || '';
    var CallStatus = req.body.CallStatus || '';
    var callInfo   = activeCalls[CallSid] || {};
    console.log('Call status:', callInfo.name || CallSid, '-', CallStatus);

    if (['no-answer','busy','failed','canceled'].includes(CallStatus)) {
      notifyApp({
        memberId: callInfo.memberId,
        sessionId: callInfo.sessionId,
        responding: false,
        name: callInfo.name,
        status: CallStatus
      });
    }
    delete activeCalls[CallSid];
  } catch (err) {
    console.error('Status callback error:', err.message);
  }
  res.sendStatus(200);
});

// ── FIRESTORE NOTIFY ──────────────────────────────────────────
async function notifyApp(data) {
  const db = getDb();
  if (!db) { console.warn('Firestore not available'); return; }
  try {
    await db.collection('recall-responses').add({
      memberId:   data.memberId   || '',
      sessionId:  data.sessionId  || '',
      responding: data.responding || false,
      name:       data.name       || '',
      status:     data.status     || (data.responding ? 'answered-yes' : 'answered-no'),
      timestamp:  admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('Firestore updated:', data.name, data.responding ? 'COMING IN' : 'NOT COMING IN');
  } catch (err) {
    console.error('Firestore write error:', err.message);
  }
}

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', function(req, res) {
  res.json({
    status: 'ok',
    service: 'FFD Recall Backend',
    backendUrl: BACKEND_URL,
    firebaseReady: admin.apps.length > 0,
    timestamp: new Date().toISOString()
  });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('FFD Recall Backend running on port', PORT);
  console.log('Backend URL:', BACKEND_URL);
});
