# Talk Codex Gemini (Quantum Debate Simulator)

**Gemini-Codex 웹 양자 토론 시뮬레이터**는 두 개의 AI 에이전트(Gemini와 Codex)가 특정 주제에 대해 토론하는 과정을 시뮬레이션하는 웹 애플리케이션입니다. 로컬 환경에서 구동되며, 3개의 터미널 패널(Gemini, 중계, Codex)을 통해 실시간으로 토론 과정을 관찰하고 제어할 수 있습니다.

![License](https://img.shields.io/badge/license-ISC-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![React](https://img.shields.io/badge/React-19-blue)
![Vite](https://img.shields.io/badge/Vite-7.3-purple)
![Express](https://img.shields.io/badge/Express-5.2-green)

---

## 1. 프로젝트 개요 (Project Overview)

이 프로젝트는 **Codex**와 **Gemini**라는 두 AI 모델이 서로 턴을 주고받으며 합의점에 도달하거나 정해진 라운드까지 토론을 진행하도록 설계되었습니다.

- **핵심 기능**:
  - **3패널 UI**: 좌측(Gemini), 중앙(토론 중계), 우측(Codex) 터미널을 통한 직관적인 모니터링.
  - **턴 기반 토론**: `Codex -> Gemini -> Codex ...` 순서로 엄격한 턴 관리.
  - **실시간 제어**: 토론 시작, 일시정지(턴 경계에서), 재개, 즉시 중지 기능.
  - **자동 합의 감지**: 설정된 키워드(예: "합의", "동의") 감지 시 토론 자동 종료.
  - **영구 저장**: 세션 ID와 토론 로그를 파일 시스템(`logs/`)에 저장하여 지속성 보장.

## 2. 아키텍처 (Architecture)

이 프로젝트는 **Monorepo** 구조로, 백엔드(Server)와 프론트엔드(Web)가 분리되어 있으나 하나의 저장소에서 관리됩니다.

### 2.1 Backend (`server/`)
- **Runtime**: Node.js + Express
- **DebateEngine**: 토론의 상태(Idle, Running, Paused 등)를 관리하는 유한 상태 머신(FSM).
- **CliAgentRunner**: 실제 AI 에이전트 CLI(Command Line Interface)를 자식 프로세스(`spawn`)로 실행하고 입출력을 제어.
- **WebSocket**: 클라이언트(Web)와 실시간으로 상태 및 로그를 동기화.
- **Persistence**: `logs/sessions.json` 및 `logs/runs/*.jsonl` 파일에 데이터 저장.

### 2.2 Frontend (`web/`)
- **Framework**: React + Vite
- **UI Architecture**:
  - **TerminalPane**: `xterm.js`를 래핑하여 실제 터미널과 유사한 경험 제공.
  - **State Management**: `useReducer`를 사용한 복합 상태 관리.
  - **WebSocket Client**: 서버와의 양방향 통신 담당.

### 2.3 데이터 흐름 (Data Flow)
1. **User**: UI에서 "토론 시작" 클릭.
2. **Server**: `DebateEngine`이 활성화되며 `CliAgentRunner`를 통해 Codex CLI 실행.
3. **CLI**: AI 모델의 응답 생성 (Stdout).
4. **Server**: 응답을 파싱하고, `WebSocket`을 통해 UI로 전송 및 로그 저장.
5. **Server**: 상대방(Gemini)의 턴으로 전환하여 프로세스 반복.

## 3. 디렉토리 구조 (Directory Structure)

```bash
talk_codex_gemini/
├── package.json          # 프로젝트 루트 설정 및 스크립트
├── server/               # 백엔드 소스 코드
│   ├── index.ts          # 서버 진입점 (Express + WebSocket)
│   ├── debate-engine.ts  # 핵심 토론 로직 (FSM)
│   ├── cli-runner.ts     # CLI 프로세스 실행기
│   └── ...
├── web/                  # 프론트엔드 소스 코드
│   ├── src/
│   │   ├── App.tsx       # 메인 UI 컴포넌트
│   │   ├── terminal-pane.tsx # xterm.js 터미널 컴포넌트
│   │   └── ...
│   └── vite.config.ts    # Vite 설정
├── logs/                 # 실행 로그 및 세션 데이터 저장소
└── scripts/              # 개발 편의 스크립트
```

## 4. 설치 및 실행 (Installation & Setup)

### 4.1 사전 요구사항
- Node.js (v24.12.0 이상 권장)
- npm (v11.6.2 이상)

### 4.2 설치
```bash
npm install
```

### 4.3 환경 변수 설정
`.env.example` 파일을 복사하여 `.env` 파일을 생성하고, 실제 사용할 AI CLI 명령어를 설정하세요.

```bash
cp .env.example .env
```

**`.env` 설정 예시 (권장):**
```dotenv
PORT=8787
CONSENSUS_REGEX=(합의|동의|consensus|agreed)
DEFAULT_MAX_ROUNDS=6
TURN_TIMEOUT_MS=120000

# Real CLI wrapper 설정 (JSON 표준화)
GEMINI_START_CMD=node scripts/run_gemini_cli.mjs --mode start --prompt {prompt}
GEMINI_RESUME_CMD=node scripts/run_gemini_cli.mjs --mode resume --session {session_id} --prompt {prompt}
CODEX_START_CMD=node scripts/run_codex_cli.mjs --mode start --prompt {prompt}
CODEX_RESUME_CMD=node scripts/run_codex_cli.mjs --mode resume --session {session_id} --prompt {prompt}
```

> 참고:
> - `start` 템플릿은 `{prompt}`를 포함해야 합니다.
> - `resume` 템플릿은 `{session_id}`와 `{prompt}`를 모두 포함해야 합니다.
> - `scripts/mock_agent.mjs`는 테스트/검증용입니다.

### 4.4 개발 모드 실행
서버와 클라이언트를 동시에 실행합니다.

```bash
npm run dev
```
- **Web UI**: [http://localhost:5173](http://localhost:5173)
- **API Server**: [http://localhost:8787](http://localhost:8787)

### 4.5 백그라운드 실행/상태 점검
개발 서버를 분리 프로세스로 실행하고 상태를 확인할 수 있습니다.

```bash
npm run dev:up
npm run dev:status
npm run dev:down
```

- **Server Log**: `.logs/server.log`
- **Web Log**: `.logs/web.log`

## 5. 사용 가이드 (Usage Guide)

1.  **에이전트 연결**: 웹 UI 하단의 **"Gemini 구동/재연결"**, **"Codex 구동/재연결"** 버튼을 눌러 각 에이전트 세션을 준비합니다. (Ready 상태 확인)
2.  **주제 입력**: 상단 입력창에 토론하고 싶은 주제를 입력합니다. (예: "React vs Vue 장단점 분석")
3.  **토론 시작**: **"토론 시작"** 버튼을 클릭합니다.
4.  **모니터링 & 제어**:
    - 중앙 패널에서 실시간 대화 내용을 확인합니다.
    - **"일시정지"**: 현재 발언(Turn)이 끝난 후 토론을 멈춥니다.
    - **"재개"**: 멈춘 지점부터 토론을 다시 시작합니다.
    - **"중지"**: 즉시 토론을 강제 종료합니다.

## 6. 문제 해결 (Troubleshooting)

### Q: `ERR_CONNECTION_REFUSED` 에러가 발생합니다.
- 웹 서버나 API 서버가 정상적으로 실행되지 않았을 수 있습니다.
- `npm run dev:status`로 `5173`/`8787` 리스닝 상태를 먼저 확인하세요.
- 필요 시 `npm run dev:down && npm run dev:up`으로 재기동하세요.
- `localhost`가 실패하면 `http://127.0.0.1:5173`도 확인하세요.

### Q: 에이전트가 응답하지 않거나 오류가 발생합니다.
- `.env` 파일에 설정된 CLI 명령어가 올바른지, 해당 CLI 도구가 시스템에 설치되어 있는지 확인하세요.
- 로그 패널에 출력되는 에러 메시지를 확인하세요.
- Gemini 연결은 초기 구동 시 수십 초 소요될 수 있습니다.

### Q: `WebSocket 연결 오류가 발생했습니다`가 표시됩니다.
- 서버(`8787`)가 중단되었거나 네트워크 일시 오류일 수 있습니다.
- 클라이언트는 자동 재연결을 시도하므로 잠시 대기 후 상태를 확인하세요.
- 지속되면 `npm run dev:status` 확인 후 재기동하세요.

## 7. 테스트 (Testing)
프로젝트의 안정성을 검증하기 위해 단위 테스트를 실행할 수 있습니다.

```bash
npm test
```
- **포함 내용**: CLI Command Runner, Debate Engine FSM, UI 로직 검증.

## 8. 문서 (Docs)
- 구현 계획: `docs/PLAN.md`
- 제품 요구사항: `docs/PRD.md`
- 기술 요구사항: `docs/TRD.md`
