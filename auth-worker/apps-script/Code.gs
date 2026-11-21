const MAX_REQUEST_LENGTH = 8192;
const SHARED_SECRET_PROPERTY = 'WORKER_SHARED_SECRET';

function doPost(event) {
  const rawBody = event && event.postData && event.postData.contents;
  if (!rawBody || rawBody.length > MAX_REQUEST_LENGTH) {
    return jsonOutput({ ok: false, error: 'invalid_request' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    return jsonOutput({ ok: false, error: 'invalid_request' });
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonOutput({ ok: false, error: 'invalid_request' });
  }

  const expectedSecret = PropertiesService.getScriptProperties()
    .getProperty(SHARED_SECRET_PROPERTY) || '';
  if (expectedSecret.length < 32 || !constantTimeEqual(payload.secret, expectedSecret)) {
    return jsonOutput({ ok: false, error: 'unauthorized' });
  }

  const email = String(payload.email || '').trim().toLowerCase();
  const code = String(payload.code || '');
  if (email.length > 254 || !/^[^@\s]+@talthelife\.com$/.test(email) || !/^[0-9]{6}$/.test(code)) {
    return jsonOutput({ ok: false, error: 'invalid_request' });
  }

  const name = String(payload.name || 'צוות טל החיים')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 100);
  const roleLabel = payload.role === 'Admin' ? 'מנהל מערכת' : 'צוות';
  const subject = 'קוד אימות כניסה למערכת - טל החיים CRM';
  const textBody = `היי ${name} (${roleLabel}),\n\nקוד האימות שלך לכניסה למערכת ה-CRM הוא:\n\n${code}\n\nהקוד תקף למשך 10 דקות. אם לא ביקשת כניסה, אפשר להתעלם מהודעה זו.\n\nצוות טל החיים`;
  const htmlBody = `<div dir="rtl" style="font-family:Arial,sans-serif;color:#0b1f44"><p>היי ${escapeHtml(name)} (${roleLabel}),</p><p>קוד האימות שלך לכניסה למערכת ה-CRM הוא:</p><p style="font-size:30px;font-weight:bold;letter-spacing:7px;color:#2563eb">${code}</p><p>הקוד תקף למשך 10 דקות. אם לא ביקשת כניסה, אפשר להתעלם מהודעה זו.</p><p>צוות טל החיים</p></div>`;

  try {
    GmailApp.sendEmail(email, subject, textBody, {
      htmlBody,
      name: 'טל החיים CRM'
    });
    return jsonOutput({ ok: true });
  } catch (error) {
    console.error('OTP email delivery failed.');
    return jsonOutput({ ok: false, error: 'delivery_failed' });
  }
}

function doGet() {
  return jsonOutput({ ok: false, error: 'method_not_allowed' });
}

function constantTimeEqual(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => {
    const replacements = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return replacements[character];
  });
}

function jsonOutput(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
