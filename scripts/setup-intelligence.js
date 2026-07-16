// One-time provisioning for real-time Conversation Intelligence (v3).
//
// Creates, in order:
//   1. A Memory Store (required by Conversation Orchestrator for profile resolution)
//   2. An Intelligence Configuration with a rule: Summary operator, fires every 2
//      customer/agent utterances (COMMUNICATION trigger), delivered to /intelligence-webhook
//   3. A Conversation Orchestrator Configuration linking the two, for active (per-call,
//      TwiML/API-driven) ingestion - no capture rules needed for that ingestion mode.
//
// Run once after PUBLIC_HOSTNAME is set in .env (ngrok must be running so the webhook
// action URL is reachable). Prints the resulting TWILIO_CONVERSATION_CONFIG_ID to paste
// into .env. Re-run (it creates new resources each time) if your ngrok hostname changes.

require('dotenv').config();

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_HOSTNAME } = process.env;

const SUMMARY_OPERATOR_ID =
  process.env.TWILIO_SUMMARY_OPERATOR_ID || 'intelligence_operator_01kcv35pnkeysaf6z6cqtbpegn';

if (!PUBLIC_HOSTNAME) {
  console.error('Set PUBLIC_HOSTNAME in .env (your ngrok hostname) before running this script.');
  process.exit(1);
}

const authHeader =
  'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

async function callApi(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  console.log('Creating Memory Store...');
  const memoryStore = await callApi('https://memory.twilio.com/v1/ControlPlane/Stores', {
    displayName: 'ConvoRelay POC Memory Store',
  });
  console.log(`  memoryStoreId: ${memoryStore.id}`);

  console.log('Creating Intelligence Configuration (Summary operator, real-time)...');
  const intelligenceConfig = await callApi(
    'https://intelligence.twilio.com/v3/ControlPlane/Configurations',
    {
      displayName: 'ConvoRelay POC Live Summary',
      rules: [
        {
          operators: [{ id: SUMMARY_OPERATOR_ID }],
          triggers: [{ on: 'COMMUNICATION', parameters: { count: 2 } }],
          actions: [
            {
              type: 'WEBHOOK',
              method: 'POST',
              url: `https://${PUBLIC_HOSTNAME}/intelligence-webhook`,
            },
          ],
        },
      ],
    }
  );
  console.log(`  intelligenceConfigurationId: ${intelligenceConfig.id}`);

  console.log('Creating Conversation Orchestrator Configuration...');
  const conversationConfig = await callApi(
    'https://conversations.twilio.com/v2/ControlPlane/Configurations',
    {
      displayName: 'ConvoRelay POC',
      description: 'Active per-call voice ingestion for ConvoRelay POC warm transfer summaries.',
      conversationGroupingType: 'GROUP_BY_PARTICIPANT_ADDRESSES_AND_CHANNEL_TYPE',
      memoryStoreId: memoryStore.id,
      intelligenceConfigurationIds: [intelligenceConfig.id],
    }
  );
  console.log(`  conversationConfigurationId: ${conversationConfig.id}`);

  console.log('\nAdd this to your .env:\n');
  console.log(`TWILIO_CONVERSATION_CONFIG_ID=${conversationConfig.id}`);
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
