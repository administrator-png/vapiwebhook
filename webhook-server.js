/**
 * Vapi Webhook Server for Cal.com Integration
 * Receives function calls from Vapi and routes them to Cal.com API
 */

require('dotenv').config({ path: '../.env' });
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());

// Cal.com API configuration
const CAL_API_KEY = process.env.CAL_API_KEY;
const CAL_API_BASE_URL = 'https://api.cal.com/v1';
const CAL_EVENT_TYPE_ID = process.env.CAL_EVENT_TYPE_ID || 3917527;

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

// Function handlers
async function handleGetAvailableSlots(params) {
  console.log('📅 Getting available slots for:', params.date);

  try {
    const timeZone = 'Europe/London';
    const startTime = `${params.date}T00:00:00Z`;
    const endTime = `${params.date}T23:59:59Z`;
    const url = `${CAL_API_BASE_URL}/slots?apiKey=${CAL_API_KEY}&eventTypeId=${CAL_EVENT_TYPE_ID}&startTime=${startTime}&endTime=${endTime}&timeZone=${encodeURIComponent(timeZone)}`;

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
    console.log('📥 Response data:', JSON.stringify(data).substring(0, 200));

    const dateSlots = data.slots?.[params.date] || [];
    const formattedSlots = formatSlots(dateSlots);

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
    const startTime = parseDateTime(params.date, params.time);

    const bookingPayload = {
      eventTypeId: CAL_EVENT_TYPE_ID,
      start: startTime,
      timeZone: 'Europe/London',
      language: 'en',
      metadata: {},
      responses: {
        name: params.customerName,
        email: params.customerEmail,
        location: { optionValue: '', value: 'integrations:zoom' },
        notes: params.notes || 'Booked via AI Receptionist'
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
    console.log('✅ Booking created:', booking.id);

    return {
      success: true,
      bookingId: booking.id,
      bookingUid: booking.uid,
      message: `Perfect! I have booked your appointment for ${params.time} on ${params.date}. You will receive a confirmation email at ${params.customerEmail} with the Zoom meeting link. Is there anything else I can help you with?`
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    calApiConfigured: !!CAL_API_KEY
  });
});

// Start server
app.listen(PORT, () => {
  console.log('\n🚀 Vapi Webhook Server Started');
  console.log('================================');
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log(`📅 Cal.com API: ${CAL_API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log('================================\n');
  console.log('Waiting for function calls from Vapi...\n');
});
