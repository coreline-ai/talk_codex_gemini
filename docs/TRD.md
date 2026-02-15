# Gemini-Codex 웹 양자 토론 시뮬레이터 TRD

## 1. 문서 개요
- 문서 목적: 시스템 구현 상세(아키텍처, 인터페이스, 상태머신, 운영 규칙) 정의
- 범위: 로컬 단일 사용자 기준 v1 구현
- 기준 코드베이스: `server/*`, `web/src/*`, `scripts/*`

## 2. 기술 스택
- 런타임: Node.js (ESM)
- 백엔드: Express, ws(WebSocket)
- 프론트엔드: React + Vite + xterm
- 테스트: Vitest
- 설정: dotenv (`.env`)

## 3. 시스템 아키텍처
- 프론트엔드(UI):
  - `web/src/App.tsx`: 제어 UI + API 호출 + WS 이벤트 반영
  - `web/src/terminal-pane.tsx`: xterm 렌더링
  - `web/src/ws-client.ts`: WS 연결/재연결
  - `web/src/state.ts`: UI 상태/리듀서
- 백엔드:
  - `server/index.ts`: HTTP API + WS 브로드캐스트
  - `server/debate-engine.ts`: 토론 FSM/턴 제어
  - `server/cli-runner.ts`: CLI 호출/파싱/타임아웃/취소
  - `server/session-store.ts`: 세션 파일 저장
  - `server/run-log-store.ts`: run 로그/summary 저장
- CLI 래퍼:
  - `scripts/run_gemini_cli.mjs`
  - `scripts/run_codex_cli.mjs`

## 4. 데이터 모델

### 4.1 Core Types
- `AgentName`: `"gemini" | "codex"`
- `AgentStatus`: `"idle" | "connecting" | "ready" | "error"`
- `DebateStatus`: `"idle" | "running" | "pause_requested" | "paused" | "stopping" | "stopped" | "completed"`

### 4.2 저장 포맷
- 세션 파일: `logs/sessions.json`
  - `{ updatedAt, gemini, codex }`
- 토론 로그(JSONL): `logs/runs/<runId>.jsonl`
  - `TranscriptEntry` 단위 append
- 요약 파일: `logs/runs/<runId>.summary.json`
  - `{ runId, topic, maxRounds, status, round, reason, createdAt, updatedAt }`

## 5. API 계약

### 5.1 HTTP
1. `POST /api/agents/:agent/connect`
   - request: `{ resumeSessionId?: string }`
   - response: `{ ok: true, session }`
2. `POST /api/debate/start`
   - request: `{ topic: string, maxRounds?: number }`
   - response: `{ ok: true, state }`
3. `POST /api/debate/pause`
4. `POST /api/debate/resume`
5. `POST /api/debate/stop`
6. `GET /api/debate/state`
7. `GET /api/runs/:runId`

### 5.2 WebSocket 이벤트
- `agent_status`
- `debate_state`
- `turn_log`
- `panel_output`
- `error`

## 6. 상태머신(FSM) 정의

### 6.1 Debate Status 전이
- `idle -> running`: start 성공
- `running -> pause_requested`: pause 요청
- `pause_requested -> paused`: 현재 턴 종료
- `paused -> running`: resume
- `running|pause_requested|paused -> stopping -> stopped`: stop
- `running -> completed`: 합의 감지 또는 최대 턴 종료

### 6.2 Agent Status 전이
- `idle -> connecting -> ready`
- 오류 발생 시 `error`

## 7. 토론 실행 알고리즘
1. start 시 runId 생성, summary 초기화
2. 라운드 루프:
   - Codex turn 실행
   - Gemini turn 실행
3. 각 turn마다:
   - prompt 생성
   - CLI 호출
   - stdout/stderr 기록
   - `turn_log` 이벤트 전송
   - jsonl append + summary update
4. 종료 조건 체크:
   - consensus regex
   - maxRounds
   - stop/pause 플래그

## 8. CLI 실행 규칙
- `.env` 필수 항목 검증:
  - `GEMINI_START_CMD`, `GEMINI_RESUME_CMD`
  - `CODEX_START_CMD`, `CODEX_RESUME_CMD`
- placeholder 검증:
  - start: `{prompt}`
  - resume: `{session_id}`, `{prompt}`
- 치환 시 shell quote 적용
- 파싱 우선순위:
  - JSON 파싱 우선
  - 실패 시 raw text fallback

## 9. 성능/지연 특성
- 구조상 턴은 순차 실행(병렬 불가)
- 각 턴마다 별도 CLI 프로세스 spawn
- 응답 지연은 모델/CLI 부팅/네트워크 영향을 받음
- Gemini 연결은 상대적으로 긴 초기 지연 가능

## 10. 복원력/오류 처리
- turn timeout 초과 시 실패 처리 후 상태 전이
- 빈 응답 연속 발생 시 중단
- WS 단절 시 클라이언트 자동 재연결
- WS 미수신 시에도 UI는 API 응답으로 상태 반영

## 11. 보안 고려사항
- 명령 템플릿은 `.env` 고정 (UI 수정 불가)
- placeholder 값 quoting으로 주입 위험 완화
- 로컬 개발 범위로 인증/권한은 미포함

## 12. 테스트 전략
- 단위 테스트:
  - `server/cli-runner.test.ts`
  - `server/debate-engine.test.ts`
  - `web/src/state.test.ts`
- 빌드 검증:
  - `npm run build`
- 런타임 스모크:
  - connect/start/state API 검증

## 13. 운영 가이드(로컬)
- 실행:
  - `npm run dev`
- 문제 시:
  - `npm run dev:status`
  - `npm run dev:down && npm run dev:up`
- 로그:
  - `.logs/server.log`, `.logs/web.log`
  - `logs/runs/*`

## 14. 향후 기술 개선안
- Codex/Gemini 프로세스 풀링 또는 상주 모드
- 프롬프트 길이 상한/요약 도입으로 latency 절감
- WS 헬스 상태를 UI 배지로 명시
- 턴별 latency 및 토큰 사용량 가시화
