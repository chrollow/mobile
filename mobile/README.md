# PharmAlala Mobile (Expo)

Quick start

1. Install Expo CLI globally if you don't have it:

```bash
npm install -g expo-cli
```

2. Install dependencies:

```bash
cd mobile
npm install
```

3. Start the dev server:

```bash
npm start
```

Notes

- The example `App.js` schedules a local notification and includes a placeholder for sending the Expo push token to a backend.
- When calling the local backend from an Android emulator use `http://10.0.2.2:4000`. On a physical device, point to your machine's LAN IP and ensure the backend is reachable.
