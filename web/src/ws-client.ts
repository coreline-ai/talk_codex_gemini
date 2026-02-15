export interface WsEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface WsClient {
  close: () => void;
}

function wsUrlFromLocation(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export function connectWs(
  onEvent: (event: WsEvent) => void,
  onError: (error: string) => void,
  onConnected?: () => void,
): WsClient {
  let socket: WebSocket | null = null;
  let heartbeat: number | null = null;
  let reconnectTimer: number | null = null;
  let manualClose = false;
  let errorAnnounced = false;

  const clearTimers = () => {
    if (heartbeat) window.clearInterval(heartbeat);
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    heartbeat = null;
    reconnectTimer = null;
  };

  const scheduleReconnect = () => {
    if (manualClose || reconnectTimer) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
  };

  const connect = () => {
    clearTimers();
    socket = new WebSocket(wsUrlFromLocation());

    socket.onopen = () => {
      errorAnnounced = false;
      onConnected?.();
      heartbeat = window.setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 15_000);
    };

    socket.onmessage = (messageEvent) => {
      try {
        const parsed = JSON.parse(String(messageEvent.data)) as WsEvent;
        onEvent(parsed);
      } catch {
        // ignore malformed messages
      }
    };

    socket.onerror = () => {
      if (!errorAnnounced) {
        errorAnnounced = true;
        onError("WebSocket 연결 오류가 발생했습니다. 재연결을 시도합니다.");
      }
    };

    socket.onclose = () => {
      if (heartbeat) {
        window.clearInterval(heartbeat);
        heartbeat = null;
      }
      scheduleReconnect();
    };
  };

  connect();

  return {
    close: () => {
      manualClose = true;
      clearTimers();
      socket?.close();
    },
  };
}
