import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const instance = axios.create({
  baseURL: 'http://192.168.254.165:4000',
  timeout: 5000,
});

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
