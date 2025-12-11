/**
 * Vapi Webhook Server for Cal.com Integration
 * Receives function calls from Vapi and routes them to Cal.com API
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.WEBHOOK_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static('public'));

// Cal.com API configuration
const CAL_API_KEY = process.env.CAL_API_KEY || process.env.EXPO_PUBLIC_CAL_API_KEY;
const CAL_API_BASE_URL = 'https://api.cal.com/v1';
const CAL_USERNAME = 'sonic-iq-6ttuqv';
const CAL_EVENT_TYPE_ID = 3917527; // 30 Min Meeting
const CAL_EVENT_TYPE_SLUG = '30min';

// Twilio WhatsApp configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Debug: Log environment variable status on startup
console.log('🔍 Environment Check:');
console.log('  process.env.CAL_API_KEY:', process.env.CAL_API_KEY ? 'SET' : 'MISSING');
console.log('  process.env.EXPO_PUBLIC_CAL_API_KEY:', process.env.EXPO_PUBLIC_CAL_API_KEY ? 'SET' : 'MISSING');
console.log('  Final CAL_API_KEY value:', CAL_API_KEY ? 'SET' : 'MISSING');
console.log('  All env keys:', Object.keys(process.env).filter(k => k.includes('CAL') || k.includes('API')).join(', '));

// Helper function to parse date and time
function parseDateTime(dateString, timeString) {
  // dateString format: YYYY-MM-DD
  // timeString format: "2:00 PM" or "14:00"

  const date = new Date(dateString);

  // Parse time
  let hours, minutes;
  if (timeString.includes('AM') || timeString.includes('PM')) {
    // 12-hour format
    const [time, period] = timeString.split(' ');
    const [h, m] = time.split(':');
    hours = parseInt(h);
    minutes = parseInt(m) || 0;

    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
  } else {
    // 24-hour format
    const [h, m] = timeString.split(':');
    hours = parseInt(h);
    minutes = parseInt(m) || 0;
  }

  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

// Helper function to format time slots
function formatSlots(slots) {
  if (!slots || slots.length === 0) {
    return [];
  }

  return slots.map(slot => {
    const date = new Date(slot.time);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Europe/London'
    });
  });
}

// Helper function to send WhatsApp message via Twilio
async function sendWhatsAppMessage(to, message) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.log('⚠️  Twilio not configured, skipping WhatsApp message');
    return { success: false, error: 'Twilio not configured' };
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

    const formData = new URLSearchParams({
      To: `whatsapp:${to}`,
      From: `whatsapp:${TWILIO_PHONE_NUMBER}`,
      Body: message,
    });

    const credentials = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Twilio WhatsApp error:', errorText);
      return { success: false, error: errorText };
    }

    const data = await response.json();
    console.log('✅ WhatsApp message sent:', data.sid);
    return { success: true, messageId: data.sid };
  } catch (error) {
    console.error('❌ Error sending WhatsApp:', error.message);
    return { success: false, error: error.message };
  }
}

// Function handlers
async function handleGetAvailableSlots(params) {
  console.log('📅 Getting available slots for:', params.date);

  try {
    // V1 API uses eventTypeId for /slots endpoint
    const url = `${CAL_API_BASE_URL}/slots?apiKey=${CAL_API_KEY}&eventTypeId=${CAL_EVENT_TYPE_ID}&startTime=${params.date}T00:00:00Z&endTime=${params.date}T23:59:59Z`;

    console.log('📤 Request URL:', url);

    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Cal.com error:', errorText);
      return {
        success: false,
        error: 'Failed to get available slots',
        message: 'I apologize, but I am having trouble checking the calendar right now. Please try again in a moment.'
      };
    }

    const data = await response.json();
    console.log('📥 Response data:', JSON.stringify(data, null, 2));

    // V1 API returns: { slots: { "2025-12-18": [{time: "ISO"}, ...] } }
    const dateSlots = data.slots?.[params.date] || [];
    const slots = dateSlots;
    const formattedSlots = formatSlots(slots);

    console.log(`✅ Found ${formattedSlots.length} available slots`);

    if (formattedSlots.length === 0) {
      return {
        success: true,
        slots: [],
        message: `I do not have any available appointments on ${params.date}. Would you like to try a different date?`
      };
    }

    const slotsText = formattedSlots.slice(0, 5).join(', ');
    return {
      success: true,
      slots: formattedSlots,
      message: `I have the following times available on ${params.date}: ${slotsText}. Which time works best for you?`
    };

  } catch (error) {
    console.error('❌ Error:', error.message);
    return {
      success: false,
      error: error.message,
      message: 'I apologize, but I am having trouble checking the calendar. Please try again.'
    };
  }
}

async function handleBookAppointment(params) {
  console.log('📝 Booking appointment for:', params.customerName);

  try {
    // Parse date and time
    const startTime = parseDateTime(params.date, params.time);

    // Use provided email or generate placeholder if not provided
    const email = params.customerEmail || `pending-${params.customerPhone.replace(/\D/g, '')}@scteeth.temp`;
    const needsEmailConfirmation = !params.customerEmail;

    console.log('📧 Email:', email, needsEmailConfirmation ? '(placeholder - needs confirmation)' : '(provided)');

    const bookingPayload = {
      eventTypeId: CAL_EVENT_TYPE_ID,
      start: startTime,
      timeZone: 'Europe/London',
      language: 'en',
      metadata: {},
      responses: {
        name: params.customerName,
        email: email,
        location: { optionValue: '', value: 'integrations:zoom' },
        notes: params.notes || (needsEmailConfirmation ? 'Booked via AI Receptionist - Email pending via WhatsApp' : 'Booked via AI Receptionist')
      }
    };

    console.log('📤 Sending booking request...');
    console.log('📦 Booking payload:', JSON.stringify(bookingPayload, null, 2));

    const response = await fetch(`${CAL_API_BASE_URL}/bookings?apiKey=${CAL_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookingPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Booking failed:', errorText);
      return {
        success: false,
        error: errorText,
        message: 'I apologize, but I was unable to create the booking. The time slot may no longer be available. Would you like to try a different time?'
      };
    }

    const booking = await response.json();

    // Log full response to see structure
    console.log('📦 Full booking response:', JSON.stringify(booking, null, 2));

    // Handle different response structures from Cal.com API
    const bookingId = booking.id || booking.data?.id;
    const bookingUid = booking.uid || booking.data?.uid;

    console.log('✅ Booking created successfully');
    console.log('📋 Booking ID:', bookingId);
    console.log('📋 Booking UID:', bookingUid);

    if (!bookingUid) {
      console.error('❌ WARNING: No booking UID found in response!');
    }

    // Send WhatsApp message
    let whatsappMessage;
    let whatsappResult;
    let emailConfirmLink;

    if (needsEmailConfirmation) {
      // Send link to provide email
      emailConfirmLink = `https://vapiwebhook.onrender.com/confirm-email.html?booking=${bookingUid}&phone=${encodeURIComponent(params.customerPhone)}`;
      whatsappMessage = `Hi ${params.customerName}! Your appointment is confirmed for ${params.date} at ${params.time}.\n\nPlease click this link to confirm your name and email address:\n${emailConfirmLink}\n\nThank you! - AI Front Desk`;
    } else {
      // Email was provided, just send confirmation
      whatsappMessage = `Hi ${params.customerName}! Your appointment is confirmed for ${params.date} at ${params.time}.\n\nYou will receive a calendar invite and Zoom link at ${email}.\n\nThank you! - AI Front Desk`;
    }

    console.log('📱 Sending WhatsApp message...');
    whatsappResult = await sendWhatsAppMessage(params.customerPhone, whatsappMessage);

    if (whatsappResult.success) {
      console.log('✅ WhatsApp sent successfully');
    } else {
      console.log('⚠️  WhatsApp send failed:', whatsappResult.error);
    }

    return {
      success: true,
      bookingId: bookingId,
      bookingUid: bookingUid,
      emailConfirmLink: emailConfirmLink,
      whatsappSent: whatsappResult.success,
      message: needsEmailConfirmation
        ? `Perfect! I have booked your appointment for ${params.time} on ${params.date}. You will receive a WhatsApp message with a link to confirm your email address and get your Zoom meeting link. Is there anything else I can help you with?`
        : `Perfect! I have booked your appointment for ${params.time} on ${params.date}. You will receive email and WhatsApp confirmations shortly. Is there anything else I can help you with?`
    };

  } catch (error) {
    console.error('❌ Error:', error.message);
    return {
      success: false,
      error: error.message,
      message: 'I apologize, but I encountered an error while booking your appointment. Please try again.'
    };
  }
}

async function handleCancelAppointment(params) {
  console.log('❌ Cancelling appointment:', params.bookingUid);

  try {
    const response = await fetch(`${CAL_API_BASE_URL}/bookings/${params.bookingUid}/cancel?apiKey=${CAL_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cancellationReason: params.reason || 'Cancelled by customer'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Cancellation failed:', errorText);
      return {
        success: false,
        error: errorText,
        message: 'I apologize, but I was unable to cancel that appointment. Could you provide your booking confirmation number?'
      };
    }

    console.log('✅ Appointment cancelled');

    return {
      success: true,
      message: `I have cancelled your appointment. You will receive a confirmation email shortly. Is there anything else I can help you with?`
    };

  } catch (error) {
    console.error('❌ Error:', error.message);
    return {
      success: false,
      error: error.message,
      message: 'I apologize, but I encountered an error while cancelling your appointment.'
    };
  }
}

async function handleRescheduleAppointment(params) {
  console.log('🔄 Rescheduling appointment:', params.bookingUid);

  try {
    const newStartTime = parseDateTime(params.newDate, params.newTime);

    const response = await fetch(`${CAL_API_BASE_URL}/bookings/${params.bookingUid}/reschedule?apiKey=${CAL_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: newStartTime,
        reschedulingReason: params.reason || 'Rescheduled by customer'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Reschedule failed:', errorText);
      return {
        success: false,
        error: errorText,
        message: 'I apologize, but I was unable to reschedule that appointment. The new time may not be available.'
      };
    }

    const booking = await response.json();
    console.log('✅ Appointment rescheduled');

    return {
      success: true,
      bookingId: booking.id,
      message: `Perfect! I have rescheduled your appointment to ${params.newTime} on ${params.newDate}. You will receive an updated confirmation email. Is there anything else I can help you with?`
    };

  } catch (error) {
    console.error('❌ Error:', error.message);
    return {
      success: false,
      error: error.message,
      message: 'I apologize, but I encountered an error while rescheduling your appointment.'
    };
  }
}

// Main webhook endpoint
app.post('/webhook', async (req, res) => {
  console.log('\n🔔 Webhook received:', new Date().toISOString());
  console.log('📦 Full request body:', JSON.stringify(req.body, null, 2));

  const { message } = req.body;

  // Vapi sends tool-calls messages, not function-call messages
  if (!message || message.type !== 'tool-calls') {
    console.log('⚠️  Not a tool-calls message, ignoring');
    console.log('Message type:', message?.type);
    return res.json({ results: [] });
  }

  const { toolCallList } = message;
  if (!toolCallList || toolCallList.length === 0) {
    console.log('⚠️  No tool calls in message');
    return res.json({ results: [] });
  }

  console.log(`📞 Processing ${toolCallList.length} tool call(s)`);

  // Process each tool call and collect results
  const results = [];

  for (const toolCall of toolCallList) {
    const { id, type, function: func } = toolCall;

    if (type !== 'function') {
      console.log(`⚠️  Skipping non-function tool call: ${type}`);
      continue;
    }

    const { name, arguments: params } = func;
    console.log(`📞 Function: ${name}`);
    console.log('📥 Parameters:', JSON.stringify(params, null, 2));

    let result;

    try {
      switch (name) {
        case 'getAvailableSlots':
          result = await handleGetAvailableSlots(params);
          break;

        case 'bookAppointment':
          result = await handleBookAppointment(params);
          break;

        case 'cancelAppointment':
          result = await handleCancelAppointment(params);
          break;

        case 'rescheduleAppointment':
          result = await handleRescheduleAppointment(params);
          break;

        default:
          console.log('❓ Unknown function:', name);
          result = {
            success: false,
            error: `Unknown function: ${name}`,
            message: 'I apologize, but I am not able to perform that action right now.'
          };
      }

      console.log('📤 Result:', JSON.stringify(result, null, 2));

      // Add result with tool call ID
      results.push({
        toolCallId: id,
        result: result
      });

    } catch (error) {
      console.error('❌ Error processing tool call:', error);
      results.push({
        toolCallId: id,
        result: {
          success: false,
          error: error.message,
          message: 'I apologize, but I encountered an unexpected error. Please try again.'
        }
      });
    }
  }

  console.log(`✅ Returning ${results.length} result(s)`);
  res.json({ results });
});

// In-memory storage for corrected booking details
// In production, use a proper database
const bookingCorrections = new Map();

// API endpoint to update booking email
app.post('/api/update-email', async (req, res) => {
  console.log('\n📧 Email update request received');
  console.log('📦 Request body:', JSON.stringify(req.body, null, 2));

  const { bookingUid, email, phone, name } = req.body;

  if (!bookingUid || !email) {
    console.error('❌ Missing required fields');
    return res.status(400).json({
      success: false,
      message: 'Booking ID and email are required'
    });
  }

  console.log(`🔍 Looking up booking UID: ${bookingUid}`);

  try {
    // Fetch bookings from Cal.com V1 API
    const listUrl = `${CAL_API_BASE_URL}/bookings?apiKey=${CAL_API_KEY}`;
    console.log('📤 Fetching bookings from V1 API');

    const listResponse = await fetch(listUrl);

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      console.error('❌ Failed to fetch bookings:', errorText);
      return res.status(404).json({
        success: false,
        message: 'Unable to verify booking. The link may be invalid or expired.'
      });
    }

    const bookingsData = await listResponse.json();
    const bookings = bookingsData.bookings || [];

    // Find the booking with matching UID
    const booking = bookings.find(b => b.uid === bookingUid);

    if (!booking) {
      console.error('❌ Booking not found with UID:', bookingUid);
      return res.status(404).json({
        success: false,
        message: 'Booking not found. The link may be invalid or expired.'
      });
    }

    console.log('📋 Found booking:', JSON.stringify(booking, null, 2));

    // Extract booking details
    const appointmentDate = new Date(booking.startTime);
    const formattedDate = appointmentDate.toLocaleDateString('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const formattedTime = appointmentDate.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    const correctedName = name || booking.attendees?.[0]?.name || 'Customer';
    const oldEmail = booking.attendees?.[0]?.email;
    const isPlaceholderEmail = oldEmail && oldEmail.includes('@scteeth.temp');

    // If booking has placeholder email, cancel and rebook with correct email
    // This ensures Cal.com sends confirmation to the real email address
    if (isPlaceholderEmail) {
      console.log('📧 Placeholder email detected, canceling and rebooking with correct email...');

      try {
        // Cancel the old booking
        console.log('❌ Canceling placeholder booking...');
        const cancelResponse = await fetch(`${CAL_API_BASE_URL}/bookings/${booking.id}/cancel?apiKey=${CAL_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cancellationReason: 'Updating email address - rebooking automatically'
          })
        });

        if (!cancelResponse.ok) {
          console.error('⚠️  Failed to cancel placeholder booking, continuing anyway...');
        } else {
          console.log('✅ Placeholder booking cancelled');
        }

        // Create new booking with correct email
        console.log('📝 Creating new booking with correct email...');
        const newBookingPayload = {
          eventTypeId: booking.eventTypeId,
          start: booking.startTime,
          timeZone: booking.attendees[0]?.timeZone || 'Europe/London',
          language: 'en',
          metadata: booking.metadata || {},
          responses: {
            name: correctedName,
            email: email,
            location: booking.location || { optionValue: '', value: 'integrations:zoom' },
            notes: `Booked via AI Receptionist - Email confirmed by customer`
          }
        };

        const newBookingResponse = await fetch(`${CAL_API_BASE_URL}/bookings?apiKey=${CAL_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newBookingPayload)
        });

        if (!newBookingResponse.ok) {
          const errorText = await newBookingResponse.text();
          console.error('❌ Failed to create new booking:', errorText);
          throw new Error('Failed to rebook with correct email');
        }

        const newBooking = await newBookingResponse.json();
        console.log('✅ New booking created with correct email!');
        console.log('📋 New Booking UID:', newBooking.uid || newBooking.data?.uid);

        // Store the correction mapping
        bookingCorrections.set(bookingUid, {
          oldBookingUid: bookingUid,
          newBookingUid: newBooking.uid || newBooking.data?.uid,
          email,
          name: correctedName,
          phone,
          originalEmail: oldEmail,
          originalName: booking.attendees?.[0]?.name,
          updatedAt: new Date().toISOString()
        });

        // Get meeting link from new booking
        const meetingLink = newBooking.metadata?.videoCallUrl || newBooking.conferenceData?.url;

        // Return success - Cal.com will send confirmation email automatically
        return res.json({
          success: true,
          message: 'Email confirmed successfully! You will receive a confirmation email from Cal.com shortly.',
          booking: {
            date: formattedDate,
            time: formattedTime,
            name: correctedName
          }
        });

      } catch (rebookError) {
        console.error('❌ Error during cancel/rebook:', rebookError);
        // Fall through to send manual confirmation email
      }
    }

    // If not a placeholder email or rebook failed, store correction and send manual email
    bookingCorrections.set(bookingUid, {
      bookingUid,
      email,
      name: correctedName,
      phone,
      originalEmail: oldEmail,
      originalName: booking.attendees?.[0]?.name,
      updatedAt: new Date().toISOString()
    });

    console.log('✅ Stored corrected details:', bookingCorrections.get(bookingUid));

    // Get meeting link from booking if available
    const meetingLink = booking.metadata?.videoCallUrl || booking.conferenceData?.url;

    // Send confirmation email using Resend
    const RESEND_API_KEY = process.env.RESEND_API_KEY || process.env.EXPO_PUBLIC_RESEND_API_KEY;

    if (RESEND_API_KEY) {
      try {
        console.log('📧 Sending confirmation email via Resend...');

        const emailHtml = `
          <h2>Your Appointment is Confirmed!</h2>
          <p>Hi ${correctedName},</p>
          <p>Thank you for confirming your details. Your appointment is scheduled for:</p>
          <ul>
            <li><strong>Date:</strong> ${formattedDate}</li>
            <li><strong>Time:</strong> ${formattedTime}</li>
            ${meetingLink ? `<li><strong>Meeting Link:</strong> <a href="${meetingLink}">Join Meeting</a></li>` : ''}
          </ul>
          ${meetingLink ? '<p>You will also receive a calendar invitation shortly.</p>' : '<p>We look forward to seeing you!</p>'}
          <p>If you need to cancel or reschedule, please call us.</p>
          <p>Thank you!</p>
        `;

        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'AI Receptionist <onboarding@resend.dev>',
            to: email,
            subject: `Appointment Confirmed - ${formattedDate}`,
            html: emailHtml
          })
        });

        if (emailResponse.ok) {
          const emailData = await emailResponse.json();
          console.log('✅ Confirmation email sent:', emailData.id);
        } else {
          const emailError = await emailResponse.text();
          console.error('⚠️  Failed to send confirmation email:', emailError);
        }
      } catch (emailError) {
        console.error('⚠️  Error sending confirmation email:', emailError);
      }
    } else {
      console.log('⚠️  Resend API key not configured, skipping email');
    }

    // Return success response
    res.json({
      success: true,
      message: 'Email confirmed successfully! You will receive a confirmation email shortly.',
      booking: {
        date: formattedDate,
        time: formattedTime,
        name: correctedName
      }
    });

  } catch (error) {
    console.error('❌ Error updating email:', error);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again.'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    calApiConfigured: !!CAL_API_KEY
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 Vapi Webhook Server Started');
  console.log('================================');
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log(`📅 Cal.com API: ${CAL_API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log('================================\n');
  console.log('Waiting for function calls from Vapi...\n');
});
