import axios from 'axios';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Cloud URL comes from app.json -> extra.apiUrl (set to your Render URL).
// Falls back to the local LAN server for development.
const API_URL =
  Constants.expoConfig?.extra?.apiUrl || 'http://192.168.254.165:4000';

const instance = axios.create({
  baseURL: API_URL,
  timeout: 30000, // free Render cold-starts can take ~30-60s
});

// Retry once on timeout / network failure (covers cold starts)
instance.interceptors.response.use(
  res => res,
  async err => {
    const cfg = err.config;
    const retryable =
      err.code === 'ECONNABORTED' || err.message === 'Network Error' || !err.response;
    if (retryable && cfg && !cfg._retried) {
      cfg._retried = true;
      return instance(cfg);
    }
    return Promise.reject(err);
  }
);

export async function setAuthToken(token) {
  if (token) {
    instance.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    await AsyncStorage.setItem('token', token);
  } else {
    delete instance.defaults.headers.common['Authorization'];
    await AsyncStorage.removeItem('token');
  }
}

export async function getStoredToken() {
  return await AsyncStorage.getItem('token');
}

export default instance;
