## Gemini-Codex 웹 양자 토론 시뮬레이터 구현 계획 (3패널 + 제어 버튼)

### 1) 요약
로컬 웹앱으로 3개 패널(좌: Gemini 터미널, 중: 토론 중계 터미널, 우: Codex 터미널)을 제공하고, 주제 입력 후 `Codex 먼저 시작`하는 자동 토론 루프를 실행합니다.  
토론은 `Codex -> Gemini -> Codex ...` 순서로 반복되며, 중앙 패널에 모든 교환 로그를 누적합니다.  
버튼은 `Gemini 구동/재연결`, `Codex 구동/재연결`, `토론 시작`, `일시정지`, `재개`, `중지`를 제공합니다.

### 2) 확정된 의사결정
1. 스택: `React + Vite + Node(Express) + WebSocket`.
2. 실행 모드: `실CLI 전용` (mock 폴백 없음).
3. 일시정지: `턴 경계 정지` (현재 CLI 응답 완료 후 멈춤).
4. CLI 구동 버튼 의미: `세션 시작/재연결`.
5. 종료 조건: `합의 키워드 감지 또는 최대 턴`.
6. 기록 저장: `파일 + 메모리`.
7. 명령 설정 소스: `서버 .env 고정` (UI 수정 불가).

### 3) 범위
1. 포함:
- 3패널 터미널 UI.
- 주제 입력 및 토론 제어.
- Codex-first 토론 오케스트레이션.
- 세션 resume 관리.
- 실시간 로그 스트리밍.
- 실행 로그 파일 저장.
2. 제외:
- 멀티유저/인증.
- 원격 배포 운영 기능.
- CLI 명령 템플릿의 런타임 UI 편집.

### 4) 아키텍처
1. 프론트엔드: React(Vite), `xterm.js` 3개 인스턴스.
2. 백엔드: Express + ws.
3. 코어 엔진: `DebateEngine` 상태머신 + `CliAgentRunner`(각 CLI 호출) + `SessionStore` + `RunLogStore`.
4. 통신:
- UI -> HTTP: 명령성 제어(start/pause/resume/stop/connect).
- 서버 -> UI: WebSocket 이벤트(push)로 상태/로그/에러 전달.
5. 실행 모델:
- 단일 활성 run만 허용(동시 실행 1개).
- 각 turn은 단일 CLI 프로세스 호출 완료 후 다음 turn 진행.

### 5) 파일 구조(구현 대상)
1. `server/index.ts` (Express/ws 부트스트랩)
2. `server/debate-engine.ts` (FSM)
3. `server/cli-runner.ts` (spawn, stdout/stderr 수집, JSON 파싱)
4. `server/session-store.ts` (`logs/sessions.json` read/write)
5. `server/run-log-store.ts` (`logs/runs/<runId>.jsonl`, summary json)
6. `server/types.ts` (공유 타입)
7. `web/src/App.tsx` (3패널 레이아웃 + 컨트롤)
8. `web/src/terminal-pane.tsx` (xterm 래퍼)
9. `web/src/ws-client.ts` (이벤트 구독)
10. `web/src/state.ts` (UI 상태 관리)
11. `README.md` (실행법, .env 예시, 제약)

### 6) 공개 API/인터페이스 변경사항
```ts
type AgentName = "gemini" | "codex";
type AgentStatus = "idle" | "connecting" | "ready" | "error";
type DebateStatus = "idle" | "running" | "pause_requested" | "paused" | "stopping" | "stopped" | "completed";

interface AgentSession {
  agent: AgentName;
  sessionId: string;
  status: AgentStatus;
  lastConnectedAt: string;
}

interface DebateConfig {
  topic: string;
  maxRounds: number;      // default 6
  consensusRegex: string; // default /(합의|동의|consensus|agreed)/i
  turnTimeoutMs: number;  // default 120000
}

interface TranscriptEntry {
  runId: string;
  ts: string;
  round: number;
  from: AgentName;
  to: AgentName;
  prompt: string;
  response: string;
  rawStdout: string;
  rawStderr: string;
}
```

HTTP:
1. `POST /api/agents/:agent/connect` body `{ resumeSessionId?: string }`
2. `POST /api/debate/start` body `{ topic: string, maxRounds?: number }`
3. `POST /api/debate/pause`
4. `POST /api/debate/resume`
5. `POST /api/debate/stop`
6. `GET /api/debate/state`
7. `GET /api/runs/:runId`

WebSocket 이벤트:
1. `agent_status` `{ agent, status, sessionId?, error? }`
2. `debate_state` `{ status, runId?, round?, reason? }`
3. `turn_log` `TranscriptEntry`
4. `panel_output` `{ panel: "left"|"center"|"right", line: string }`
5. `error` `{ code, message, detail? }`

### 7) 토론 실행 시나리오(결정 완료)
1. 사용자가 Gemini/Codex 각각 `구동` 클릭.
2. 서버가 `.env`의 커맨드 템플릿으로 세션 생성 또는 resume 수행.
3. 둘 다 `ready`일 때만 `토론 시작` 활성화.
4. 시작 시 `runId` 생성, 중앙 패널에 헤더 출력.
5. 1턴 시작: Codex에 주제 프롬프트 전달.
6. Codex 응답을 우측 패널 + 중앙 패널에 기록.
7. Codex 응답을 Gemini 입력으로 전달.
8. Gemini 응답을 좌측 패널 + 중앙 패널에 기록.
9. 합의 키워드 감지 시 조기 종료, 아니면 최대 턴까지 반복.
10. `일시정지` 클릭 시 `pause_requested`, 현재 turn 완료 후 `paused`.
11. `재개` 클릭 시 다음 turn부터 재진행.
12. `중지` 클릭 시 실행 중 프로세스 종료 시도 후 `stopped`.

### 8) CLI 커맨드 정책
1. 서버 시작 시 `.env` 필수 항목 검증:
- `GEMINI_START_CMD`
- `GEMINI_RESUME_CMD`
- `CODEX_START_CMD`
- `CODEX_RESUME_CMD`
2. `{prompt}`, `{session_id}` placeholder 강제.
3. 셸 인젝션 방지:
- placeholder 값은 단일 인용 quoting 강제.
- UI 입력은 그대로 템플릿 전체 치환 불가(값 치환만 허용).
4. JSON 파싱 우선, 실패 시 raw stdout 사용.
5. session id 추출 실패 시:
- connect 단계 실패 처리(ready 불가).
- running 중에는 기존 sessionId 유지.

### 9) UI 상세 스펙
1. 상단 컨트롤 바:
- `주제 입력` 텍스트 필드.
- `토론 시작`, `일시정지`, `재개`, `중지` 버튼.
- `현재 상태`, `현재 라운드`, `runId` 배지.
2. 본문 3컬럼:
- 좌(30%): Gemini 터미널(상태 + stdout/stderr).
- 중(40%): 중계 터미널(turn 단위 요약 + 양측 메시지 시간순).
- 우(30%): Codex 터미널.
3. 하단 에이전트 바:
- `Gemini 구동/재연결` 버튼, 세션 ID 표시.
- `Codex 구동/재연결` 버튼, 세션 ID 표시.
4. 버튼 활성/비활성 규칙:
- Start: topic 존재 + 양쪽 ready + not running.
- Pause: running 상태만.
- Resume: paused 상태만.
- Stop: running/pause_requested/paused에서만.

### 10) 실패 모드와 처리
1. CLI 실행 실패(미설치/인증 실패): 해당 agent `error`, 중앙 패널 오류 출력.
2. turn 타임아웃: 해당 turn 실패 기록 후 run `stopped`.
3. WebSocket 재연결: 최근 상태 snapshot 1회 재전송.
4. pause 요청 중 stop 발생: stop 우선.
5. 빈 응답/파싱 실패: raw 로그 저장 후 엔진 정책대로 진행(연속 2회 실패 시 중단).

### 11) 테스트 케이스 및 시나리오
1. 단위 테스트:
- placeholder 치환/quoting.
- sessionId 추출(JSON, 텍스트 fallback).
- FSM 전이(idle->running->paused->running->completed/stopped).
- consensus 판정.
2. 통합 테스트(프로세스 스텁 바이너리 사용):
- Codex-first 순서 보장.
- pause 턴 경계 동작.
- stop 즉시 종료 동작.
- 최대 턴 종료.
- 세션 재연결(connect) 후 start 정상 동작.
3. UI 테스트(Playwright):
- 3패널 렌더링.
- 버튼 enable/disable 규칙.
- 중앙 패널 로그 순서(Codex 후 Gemini).
- 오류 배너 표시.
4. 수용 기준:
- 주제 입력 후 1클릭으로 토론 시작.
- 중앙 패널에 왕복 로그가 반복 누적.
- pause/resume/stop이 명세대로 동작.
- `logs/runs/*`와 `logs/sessions.json` 갱신 확인.

### 12) 구현 단계(작업 순서)
1. 서버 스캐폴딩 + 타입 + .env 검증.
2. CLI Runner 및 SessionStore 구현.
3. DebateEngine(FSM, Codex-first 루프, pause/stop).
4. WebSocket 이벤트 브로드캐스트.
5. React 3패널 UI + 버튼 제어 + 상태 반영.
6. 로그 저장 및 runs 조회 API.
7. 테스트 작성(단위/통합/UI).
8. README 정리 및 실행 스크립트 고정.

### 13) 명시적 가정/기본값
1. 런타임은 로컬 개발 환경이며 Node `v24.12.0`, npm `11.6.2` 사용 가능.
2. 단일 사용자/단일 run만 지원.
3. UI 언어는 한국어.
4. 기본 `maxRounds=6`, `turnTimeoutMs=120000`.
5. 합의 키워드는 `(합의|동의|consensus|agreed)`로 시작하고 필요 시 .env로 확장 가능.
6. 보안 범위는 로컬 개발 기준이며 인증/권한 체계는 이번 범위에서 제외.
