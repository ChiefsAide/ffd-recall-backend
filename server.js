const express = require('express');
const twilio = require('twilio');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const BACKEND_URL = process.env.BACKEND_URL;

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
const activeCalls = {};

app.post('/place-call', async (req, res) => {
  const { to, name, memberId, sessionId } = req.body;
  if (!to || !name) {
    return res.status(400).json({ error: 'Missing to or name' });
  }
  let phone = to.replace(/\D/g, '');
  if (phone.length === 10) phone = '1' + phone;
  if (!phone.startsWith('+')) phone = '+' + phone;
  try {
    const call = await client.calls.create({
      to: phone,
      from: FROM_NUMBER,
      url: BACKEND_URL + '/voice?name=' + encodeURIComponent(name) + '&memberId=' + encodeURIComponent(memberId || '') + '&sessionId=' + encodeURIComponent(sessionId || ''),
      statusCallback: BACKEND_URL + '/call-status',
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed', 'no-answer', 'busy', 'failed'],
      timeout: 30,
      machineDetection: 'Enable'
    });
    activeCalls[call.sid] = { memberId, sessionId, name, phone };
    console.log('Call placed to ' + name + ' (' + phone + ') SID: ' + call.sid);
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('Call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/voice', function(req, res) {
  var name = req.query.name || 'Member';
  var memberId = req.query.memberId || '';
  var sessionId = req.query.sessionId || '';

  if (req.body.AnsweredBy === 'machine_start' || req.body.AnsweredBy === 'fax') {
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew" language="en-US">This is an automated recall notification from Fairview Fire Department for ' + name + '. Please call back or check the Chiefs Aide app.</Say></Response>');
    return;
  }

  var actionUrl = BACKEND_URL + '/keypress?memberId=' + encodeURIComponent(memberId) + '&sessionId=' + encodeURIComponent(sessionId) + '&name=' + encodeURIComponent(name);

  var twiml = '<?xml version="1.0" encoding="UTF-8"?>';
  twiml += '<Response>';
  twiml += '<Gather numDigits="1" action="' + actionUrl + '" method="POST" timeout="10">';
  twiml += '<Say voice="Polly.Matthew" language="en-US">';
  twiml += 'This is an automated recall notification from Fairview Fire Department. ';
  twiml += name + ', there is an active recall. ';
  twiml += 'Press 1 if you are responding. ';
  twiml += 'Press 2 if you are unavailable.';
  twiml += '</Say>';
  twiml += '</Gather>';
  twiml += '<Say voice="Polly.Matthew" language="en-US">We did not receive your input. Please call back or check the Chiefs Aide app. Goodbye.</Say>';
  twiml += '</Response>';

  res.type('text/xml').send(twiml);
});

app.post('/keypress', function(req, res) {
  var digit = req.body.Digits;
  var memberId = req.query.memberId || '';
  var sessionId = req.query.sessionId || '';
  var name = req.query.name || 'Member';
  var responding = digit === '1';

  console.log(name + ' pressed ' + digit + ' - ' + (responding ? 'RESPONDING' : 'DECLINED'));
  notifyApp({ memberId: memberId, sessionId: sessionId, responding: responding, name: name });

  var twiml = '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew" language="en-US">';
  if (responding) {
    twiml += 'Thank you ' + name + '. You are marked as responding. Please respond safely. Goodbye.';
  } else {
    twiml += 'Thank you ' + name + '. You are marked as unavailable. Goodbye.';
  }
  twiml += '</Say></Response>';

  res.type('text/xml').send(twiml);
});

app.post('/call-status', function(req, res) {
  var CallSid = req.body.CallSid;
  var CallStatus = req.body.CallStatus;
  var callInfo = activeCalls[CallSid] || {};
  console.log('Call status: ' + (callInfo.name || CallSid) + ' - ' + CallStatus);
  if (CallStatus === 'no-answer' || CallStatus === 'busy' || CallStatus === 'failed' || CallStatus === 'canceled') {
    notifyApp({ memberId: callInfo.memberId, sessionId: callInfo.sessionId, responding: false, name: callInfo.name, status: CallStatus });
  }
  delete activeCalls[CallSid];
  res.sendStatus(200);
});

async function notifyApp(data) {
  try {
    var admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
    var db = admin.firestore();
    await db.collection('recall-responses').add({
      memberId: data.memberId,
      sessionId: data.sessionId,
      responding: data.responding || false,
      name: data.name,
      status: data.status || (data.responding ? 'answered-yes' : 'answered-no'),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('Response written to Firestore: ' + data.name + ' - ' + (data.responding ? 'YES' : 'NO'));
  } catch (err) {
    console.error('Firestore write error:', err.message);
  }
}

app.get('/', function(req, res) {
  res.json({ status: 'ok', service: 'FFD Recall Backend', timestamp: new Date().toISOString() });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('FFD Recall Backend running on port ' + PORT);
});
