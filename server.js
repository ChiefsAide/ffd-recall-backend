const express = require('express');
const twilio = require('twilio');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

const ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER  = process.env.TWILIO_PHONE_NUMBER;
const BACKEND_URL  = process.env.BACKEND_URL;

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

const activeCalls = {};

app.post('/place-call', async (req, res) => {
  const { to, name, memberId, sessionId } = req.
