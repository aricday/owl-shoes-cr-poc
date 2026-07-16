// One-time provisioning for real-time Conversation Intelligence (v3).
//
// Creates, in order:
//   1. A Memory Store (required by Conversation Orchestrator for profile resolution)
//   2. An Intelligence Configuration with a rule: Summary operator, fires every 2
//      customer/agent utterances (COMMUNICATION trigger), delivered to /intelligence-webhook
//   3. A Conversation Orchestrator Configuration linking the two, for active (per-call,
//      TwiML/API-driven) ingestion - no capture rules needed for that ingestion mode.
//
// Idempotent: each resource is looked up by displayName first and reused if found, since
// Memory Store displayName must be unique per account (recreating blindly on every run
// fails with a 20001 "already exists" error).
//
// Memory Store and Conversation Orchestrator Configuration creation are both async: the
// POST returns 202 with a `statusUrl`, not the resource itself. This script polls that
// URL until the operation completes. (Intelligence Configuration creation is synchronous.)
//
// Run once after PUBLIC_HOSTNAME is set in .env (ngrok must be running so the webhook
// action URL is reachable). Prints the resulting TWILIO_CONVERSATION_CONFIG_ID to paste
// into .env. Safe to re-run if your ngrok hostname changes — existing resources are reused
// (the Intelligence Configuration's webhook URL is fixed at creation time, though, so
// delete and let this script recreate it if the hostname actually changed).

require('dotenv').config();

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_HOSTNAME } = process.env;

const SUMMARY_OPERATOR_ID =
  process.env.TWILIO_SUMMARY_OPERATOR_ID || 'intelligence_operator_01kcv35pnkeysaf6z6cqtbpegn';

const MEMORY_STORE_NAME = 'convorelay-poc-store-v2';
const INTELLIGENCE_CONFIG_NAME = 'convorelay-poc-live-summary';
const CONVERSATION_CONFIG_NAME = 'convorelay-poc';

if (!PUBLIC_HOSTNAME) {
  console.error('Set PUBLIC_HOSTNAME in .env (your ngrok hostname) before running this script.');
  process.exit(1);
}

const authHeader =
  'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

async function callApi(url, { method = 'POST', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Memory Store and Conversation Orchestrator Configuration mutations return 202 with a
// statusUrl instead of the resource itself. Poll it until the operation finishes.
async function pollOperation(statusUrl) {
  for (;;) {
    const operation = await callApi(statusUrl, { method: 'GET' });
    if (operation.status === 'COMPLETED') return operation;
    if (operation.status === 'FAILED') {
      throw new Error(`Operation failed: ${JSON.stringify(operation.error || operation)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function paginate(baseUrl, itemsKey) {
  const items = [];
  let url = baseUrl;
  while (url) {
    const page = await callApi(url, { method: 'GET' });
    items.push(...(page[itemsKey] || []));
    const token = page.meta?.nextToken;
    url = token ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(token)}` : null;
  }
  return items;
}

async function findMemoryStoreByDisplayName(displayName) {
  const storeIds = await paginate('https://memory.twilio.com/v1/ControlPlane/Stores', 'stores');
  for (const id of storeIds) {
    const store = await callApi(`https://memory.twilio.com/v1/ControlPlane/Stores/${id}`, { method: 'GET' });
    if (store.displayName === displayName) return store;
  }
  return null;
}

async function findIntelligenceConfigByDisplayName(displayName) {
  const items = await paginate('https://intelligence.twilio.com/v3/ControlPlane/Configurations', 'items');
  return items.find((item) => item.displayName === displayName) || null;
}

async function findConversationConfigByDisplayName(displayName, memoryStoreId) {
  const items = await paginate(
    `https://conversations.twilio.com/v2/ControlPlane/Configurations?memoryStoreId=${memoryStoreId}`,
    'configurations'
  );
  return items.find((item) => item.displayName === displayName) || null;
}

async function getOrCreateMemoryStore() {
  const existing = await findMemoryStoreByDisplayName(MEMORY_STORE_NAME);
  if (existing) {
    console.log(`  reusing existing memoryStoreId: ${existing.id}`);
    return existing.id;
  }

  console.log('Creating Memory Store...');
  const created = await callApi('https://memory.twilio.com/v1/ControlPlane/Stores', {
    body: { displayName: MEMORY_STORE_NAME },
  });
  const operation = await pollOperation(created.statusUrl);
  const memoryStoreId = operation.result?.id;
  if (!memoryStoreId) {
    throw new Error(`Memory Store operation completed without a result id: ${JSON.stringify(operation)}`);
  }
  console.log(`  memoryStoreId: ${memoryStoreId}`);
  return memoryStoreId;
}

async function getOrCreateIntelligenceConfig() {
  const existing = await findIntelligenceConfigByDisplayName(INTELLIGENCE_CONFIG_NAME);
  if (existing) {
    console.log(`  reusing existing intelligenceConfigurationId: ${existing.id}`);
    return existing.id;
  }

  console.log('Creating Intelligence Configuration (Summary operator, real-time)...');
  const config = await callApi('https://intelligence.twilio.com/v3/ControlPlane/Configurations', {
    body: {
      displayName: INTELLIGENCE_CONFIG_NAME,
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
    },
  });
  console.log(`  intelligenceConfigurationId: ${config.id}`);
  return config.id;
}

async function getOrCreateConversationConfig(memoryStoreId, intelligenceConfigurationId) {
  const existing = await findConversationConfigByDisplayName(CONVERSATION_CONFIG_NAME, memoryStoreId);
  if (existing) {
    console.log(`  reusing existing conversationConfigurationId: ${existing.id}`);
    return existing.id;
  }

  console.log('Creating Conversation Orchestrator Configuration...');
  const created = await callApi('https://conversations.twilio.com/v2/ControlPlane/Configurations', {
    body: {
      displayName: CONVERSATION_CONFIG_NAME,
      description: 'Active per-call voice ingestion for ConvoRelay POC warm transfer summaries.',
      conversationGroupingType: 'GROUP_BY_PARTICIPANT_ADDRESSES_AND_CHANNEL_TYPE',
      memoryStoreId,
      intelligenceConfigurationIds: [intelligenceConfigurationId],
    },
  });
  await pollOperation(created.statusUrl);

  // The Configuration operation's polled result doesn't reliably carry the new ID, but
  // the initial 202 response does via `related.configurationId`. Fall back to re-listing
  // and matching by displayName if that's absent.
  let conversationConfigId = created.related?.configurationId;
  if (!conversationConfigId) {
    const match = await findConversationConfigByDisplayName(CONVERSATION_CONFIG_NAME, memoryStoreId);
    conversationConfigId = match?.id;
  }
  if (!conversationConfigId) {
    throw new Error('Could not determine the Conversation Orchestrator configuration ID after creation.');
  }
  console.log(`  conversationConfigurationId: ${conversationConfigId}`);
  return conversationConfigId;
}

async function main() {
  console.log('Looking for an existing Memory Store...');
  const memoryStoreId = await getOrCreateMemoryStore();

  console.log('Looking for an existing Intelligence Configuration...');
  const intelligenceConfigurationId = await getOrCreateIntelligenceConfig();

  console.log('Looking for an existing Conversation Orchestrator Configuration...');
  const conversationConfigId = await getOrCreateConversationConfig(memoryStoreId, intelligenceConfigurationId);

  console.log('\nAdd this to your .env:\n');
  console.log(`TWILIO_CONVERSATION_CONFIG_ID=${conversationConfigId}`);
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
