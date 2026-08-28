import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor for auth
api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem('token');
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// Response interceptor for error handling
// Auth endpoints manage their own 401 flows (Login.tsx renders the server's
// error message), so they must not be hijacked into the refresh/reload path.
const AUTH_REQUEST_URLS = ['/api/auth/login', '/api/auth/refresh'];

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const requestUrl: unknown = error.config?.url;
    const isAuthRequest =
      typeof requestUrl === 'string' && AUTH_REQUEST_URLS.some((url) => requestUrl.startsWith(url));

    if (error.response?.status === 401 && !isAuthRequest) {
      // Token expired, try to refresh
      try {
        await axios.post(
          `${API_URL}/api/auth/refresh`,
          {},
          {
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          },
        );
        // Retry original request
        return api.request(error.config);
      } catch {
        // Refresh failed, redirect to login
        localStorage.removeItem('token');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

export { api };
