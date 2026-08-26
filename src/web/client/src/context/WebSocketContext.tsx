import React, { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback } from 'react';
import { WebSocketMessage, JobProgress, LogEntry } from '@shared/types';

interface WebSocketContextType {
  isConnected: boolean;
  lastMessage: WebSocketMessage | null;
  jobProgress: Map<string, JobProgress>;
  logs: LogEntry[];
  subscribe: (jobId: string) => void;
  unsubscribe: (jobId: string) => void;
}

const WebSocketContext = createContext<WebSocketContextType | undefined>(undefined);

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000/ws';

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const [jobProgress, setJobProgress] = useState<Map<string, JobProgress>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const subscriptionsRef = useRef<Set<string>>(new Set());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        console.log('WebSocket connected');
        // Resubscribe to previous subscriptions
        subscriptionsRef.current.forEach(jobId => {
          ws.send(JSON.stringify({ type: 'subscribe', jobId }));
        });
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          setLastMessage(message);

          switch (message.type) {
            case 'progress':
              setJobProgress(prev => {
                const next = new Map(prev);
                next.set(message.data.jobId, message.data);
                return next;
              });
              break;
            case 'log':
              setLogs(prev => [...prev.slice(-99), message.data]);
              break;
            case 'notification':
              // Handle notifications
              break;
          }
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        console.log('WebSocket disconnected, reconnecting...');
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      reconnectTimeoutRef.current = setTimeout(connect, 3000);
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribe = useCallback((jobId: string) => {
    subscriptionsRef.current.add(jobId);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', jobId }));
    }
  }, []);

  const unsubscribe = useCallback((jobId: string) => {
    subscriptionsRef.current.delete(jobId);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'unsubscribe', jobId }));
    }
  }, []);

  return (
    <WebSocketContext.Provider value={{ isConnected, lastMessage, jobProgress, logs, subscribe, unsubscribe }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
}