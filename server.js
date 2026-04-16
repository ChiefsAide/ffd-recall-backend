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
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/$/, '');

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;
const activeCalls = {};

// ── FIREBASE ADMIN ────────────────────────────────────────────
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
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

  const voiceUrl = BACKEND_URL + '/voice?name=' + encodeURIComponent(name)
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

// ── VOICE ─────────────────────────────────────────────────────
app.all('/voice', function(req, res) {
  try {
    var params   = Object.assign({}, req.query, req.body);
    var name      = (params.name      || 'Member').trim();
    var memberId  = (params.memberId  || '').trim();
    var sessionId = (params.sessionId || '').trim();
    var answeredBy = params.AnsweredBy || '';

    console.log('Voice hit — name:', name, 'AnsweredBy:', answeredBy);

    var twiml = new VoiceResponse();

    if (answeredBy === 'machine_start' || answeredBy === 'fax') {
      twiml.say({ voice: 'Polly.Matthew', language: 'en-US' },
        'This is Fairview Fire Department. ' + name + ', you have been selected for a recall. ' +
        'Please call back or check the Chiefs Aide app.'
      );
      res.type('text/xml').send(twiml.toString());
      return;
    }

    var actionUrl = BACKEND_URL + '/keypress?memberId=' + encodeURIComponent(memberId)
      + '&sessionId=' + encodeURIComponent(sessionId)
      + '&name=' + encodeURIComponent(name);

    console.log('Action URL:', actionUrl);

    var gather = twiml.gather({ numDigits: '1', action: actionUrl, method: 'POST', timeout: 15 });
    gather.say({ voice: 'Polly.Matthew', language: 'en-US' },
      'Fairview Fire Department recall. ' + name + ', you are being recalled. ' +
      'Press 1 if you are coming in. Press 2 if you are not coming in.'
    );
    gather.say({ voice: 'Polly.Matthew', language: 'en-US' },
      'Press 1 if you are coming in. Press 2 if you are not coming in.'
    );
    twiml.say({ voice: 'Polly.Matthew', language: 'en-US' },
      'We did not receive a response. Please call back or check the Chiefs Aide app. Goodbye.'
    );

    console.log('TwiML:', twiml.toString());
    res.type('text/xml').send(twiml.toString());

  } catch (err) {
    console.error('Voice error:', err.message);
    var twiml = new VoiceResponse();
    twiml.say('We encountered an error. Please call back. Goodbye.');
    res.type('text/xml').send(twiml.toString());
  }
});

// ── KEYPRESS ──────────────────────────────────────────────────
app.all('/keypress', function(req, res) {
  try {
    var params    = Object.assign({}, req.query, req.body);
    var digit     = params.Digits || '';
    var memberId  = (params.memberId  || '').trim();
    var sessionId = (params.sessionId || '').trim();
    var name      = (params.name      || 'Member').trim();
    var responding = digit === '1';

    console.log('Keypress:', name, 'pressed', digit, responding ? 'COMING IN' : 'NOT COMING IN');
    notifyApp({ memberId, sessionId, responding, name });

    var twiml = new VoiceResponse();
    twiml.say({ voice: 'Polly.Matthew', language: 'en-US' },
      responding
        ? 'Thank you ' + name + '. You are marked as responding. Please respond safely. Goodbye.'
        : 'Thank you ' + name + '. You are marked as not responding. Goodbye.'
    );
    res.type('text/xml').send(twiml.toString());

  } catch (err) {
    console.error('Keypress error:', err.message);
    var twiml = new VoiceResponse();
    twiml.say('Response recorded. Goodbye.');
    res.type('text/xml').send(twiml.toString());
  }
});

// ── CALL STATUS ───────────────────────────────────────────────
app.all('/call-status', function(req, res) {
  try {
    var params     = Object.assign({}, req.query, req.body);
    var CallSid    = params.CallSid    || '';
    var CallStatus = params.CallStatus || '';
    var callInfo   = activeCalls[CallSid] || {};
    console.log('Call status:', callInfo.name || CallSid, '-', CallStatus);
    if (['no-answer','busy','failed','canceled'].includes(CallStatus)) {
      notifyApp({ memberId: callInfo.memberId, sessionId: callInfo.sessionId,
        responding: false, name: callInfo.name, status: CallStatus });
    }
    delete activeCalls[CallSid];
  } catch (err) {
    console.error('Status error:', err.message);
  }
  res.sendStatus(200);
});

// ── NOTIFY FIRESTORE ──────────────────────────────────────────
async function notifyApp(data) {
  const db = getDb();
  if (!db) { console.warn('Firestore not available'); return; }
  try {
    await db.collection('recall-responses').add({
      memberId:   data.memberId   || '',
      sessionId:  data.sessionId  || '',
      responding: data.responding || false,
      name:       data.name       || '',
      status:     data.status || (data.responding ? 'answered-yes' : 'answered-no'),
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
