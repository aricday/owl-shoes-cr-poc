# Architecture

Two diagrams of the live-call runtime: the components and how data moves between them, and
the step-by-step sequence of a single call including the warm transfer and fallback.


## Integration diagram

Components and data flow during a call — who talks to whom, and over what protocol.

```mermaid
flowchart LR
    Customer(["Customer<br/>PSTN phone"])
    Agent(["Human Agent<br/>PSTN phone"])

    subgraph Twilio["Twilio Platform"]
        Voice["Programmable Voice<br/>ConversationRelay / Conference / Calls API"]
        CI["Conversation Intelligence v3<br/>Orchestrator + Summary Operator"]
    end

    subgraph App["App Server (server.js)"]
        Webhooks["Express webhooks"]
        WS["WebSocket handler<br/>/relay"]
        Sessions[("activeSessions<br/>in-memory Map")]
    end

    OpenAI(["OpenAI API<br/>Chat Completions"])

    Customer <-->|PSTN audio| Voice
    Agent <-->|PSTN audio| Voice
    Voice <-->|"wss:// ConversationRelay protocol"| WS
    Voice -->|"TwiML webhooks (HTTPS POST)"| Webhooks
    Webhooks -->|"REST API: Calls / Conference / Transcriptions"| Voice
    WS --- Sessions
    Webhooks --- Sessions
    WS -->|"Chat Completions (streamed)"| OpenAI
    Webhooks -.->|"fallback summary completion"| OpenAI
    Voice ==>|"real-time audio/transcript"| CI
    CI -.->|"webhook POST (JSON summary)"| Webhooks
```

Notes:

- **`Voice <--> WS`** is the ConversationRelay WebSocket: inbound `setup`/`prompt`/`interrupt`/
  `dtmf`/`error`, outbound `text`/`play`/`sendDigits`/`language`/`end`.
- **`Voice --> Webhooks`** covers every TwiML fetch: `/voice/incoming`, the `<Connect action>`
  callback `/voice/relay-ended`, `/agent-whisper`, `/voice/fallback`, and the status callback
  `/agent-call-status`.
- **`Webhooks --> Voice`** covers outbound REST calls: starting/stopping the real-time
  Transcription, and placing the outbound call to the human agent.
- **`Voice ==> CI`** is one-directional and asynchronous: Twilio feeds the live transcript into
  Conversation Orchestrator on its own, independent of the request/response cycle above it.
- **`Sessions`** is plain in-memory state (`activeSessions`), not a separate service — drawn
  as its own node because both the webhook handlers and the WebSocket handler read/write it.

## Sequence diagram

A single call end-to-end: greeting, the OpenAI conversation loop, the background summary
push, the warm transfer handoff, and both branches of the agent-availability outcome.

```mermaid
sequenceDiagram
    participant Customer
    participant Twilio
    participant App as App Server
    participant OpenAI
    participant CI as Conversation Intelligence
    participant Agent as Human Agent

    Customer->>Twilio: Places call
    Twilio->>App: POST /voice/incoming
    App->>Twilio: TwiML: <Connect action="/voice/relay-ended"><ConversationRelay>
    App->>Twilio: Start real-time Transcription (REST)
    Twilio->>CI: Feed transcript via Conversation Orchestrator
    Twilio->>Customer: Connects audio (ConversationRelay WebSocket)

    loop Conversation turns
        Customer->>Twilio: Speech
        Twilio->>App: WS "prompt" (transcribed text)
        App->>OpenAI: Chat completion (streamed)
        OpenAI-->>App: Response tokens
        App->>Twilio: WS "text" tokens
        Twilio->>Customer: Spoken reply (TTS)
    end

    par Background summary pipeline
        CI->>App: POST /intelligence-webhook (pushed summary, every N utterances)
        App->>App: Cache session.liveSummary
    end

    Customer->>Twilio: "Let me speak to a human"
    Twilio->>App: WS "prompt" (handoff intent detected)
    App->>Twilio: WS "end" (handoffData: live-agent-handoff)
    Twilio->>App: POST /voice/relay-ended (<Connect action> callback)
    App->>Twilio: TwiML: <Dial><Conference endConferenceOnExit=true> (hold)
    Twilio->>Customer: Hold music
    App->>Twilio: Outbound call to agent (REST)
    Twilio->>Agent: Rings agent's phone

    alt Agent answers
        Agent->>Twilio: Answers
        Twilio->>App: POST /agent-whisper
        App->>Twilio: TwiML: <Say> summary, then <Dial><Conference endConferenceOnExit=true>
        Twilio->>Agent: Speaks cached/fallback summary
        Twilio->>Twilio: Bridges Agent + Customer in conference
        Note over Twilio: Either party hanging up now ends the call for both
    else Agent busy / no-answer / failed / timeout
        Twilio->>App: POST /agent-call-status (busy/no-answer/failed)
        App->>Twilio: Redirect customer (REST) to /voice/fallback
        Twilio->>Customer: "All lines are busy..." then hangs up
    end
```
