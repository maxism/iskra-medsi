# Project Spec - Iskra MTSBANK

## Purpose

Single source of truth for architecture, contracts, and coordinated parallel changes made manually and via AI assistants.

## Scope

- Product and technical architecture
- Module boundaries and ownership
- Integration contracts between layers
- Risk register and mitigation
- Change log for parallel work

## Current Architecture (As-Is)

### Stack

- Expo Router + React Native + TypeScript
- WebView automation via `react-native-webview`
- Local knowledge retrieval from JSON
- LLM orchestration via OpenAI-compatible API endpoint
- Auth snapshot persistence via AsyncStorage

### Layers

- Presentation: `app/`, `components/`
- Agent runtime: `hooks/useWebViewAgent.ts`, `components/WebViewAgent.tsx`
- Intelligence: `services/llm.ts`, `constants/prompts.ts`
- Knowledge: `services/knowledge.ts`, `knowledge/medsi-knowledge.json`
- Persistence: `services/authPersistence.ts`

## Contracts (Must Stay Backward-Compatible)

### WebView Message Contract

- Types: `result`, `domSnapshot`, `log`, `authSnapshot`
- `authSnapshot` is handled outside the LLM action loop

### LLM Response Contract

- Classification: strict JSON with `action` / `read` / `chat`
- Action step: strict JSON with `description`, `code`, `done`

### Safety Contract

- If current page is SmartMed sign-in, agent must stop and ask user to complete login manually

## Parallel Work Rules

- Work in one domain per change:
  - UI/UX (`components`)
  - Agent engine (`hooks`, WebView bridge)
  - LLM/RAG (`services/llm.ts`, `constants/prompts.ts`, `knowledge`)
  - Platform/state (`app/index.tsx`, auth persistence)
- If contract changes are required, update contract section first, then implementation
- Keep prompt and knowledge selector data synchronized

## Risks

- Prompt/knowledge drift for selectors and flow logic
- No unified telemetry for step-level success/failure
- No formal automated smoke checks yet
- iOS ATS is permissive for development (`NSAllowsArbitraryLoads`)

## Change Log

### 2026-04-07

- Added centralized project specification file for architecture and collaboration protocol.
- Defined stable contracts for WebView bridge and LLM responses.
- Introduced parallel work rules for conflict reduction.

## Update Protocol

When making meaningful changes:

1. Update `Current Architecture` if structure changed.
2. Update `Contracts` if message/API format changed.
3. Add a bullet in `Change Log` with date and intent.
4. Keep entries short and decision-focused.
