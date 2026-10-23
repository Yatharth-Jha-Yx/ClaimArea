# GeoQuest

A real-world GPS territory game. Walk a loop to capture the area inside it. Cross another player's live path to cut it and steal +10 points.

One player hosts a room and shares the 4-letter code; everyone else joins with it. The Node server holds the room state and validates every capture and cut.

## Run it

Requires Node 18+.

```bash
npm install
npm start
```

Open http://localhost:3000. On a laptop you can use the debug panel (press `d`) to simulate a capture without walking.

## Playing on phones (HTTPS required)

Browsers only allow GPS on `https://` pages (or `localhost`). Opening `http://192.168.x.x:3000` on a phone will load the game, but GPS will be blocked. Use one of these:

- **Quick test / LAN party:** run a tunnel next to the server and share its https URL:
  ```bash
  npx cloudflared tunnel --url http://localhost:3000
  ```
- **Permanent:** deploy to any Node host with HTTPS (Render, Railway, Fly.io). Start command: `npm start`. The server reads `PORT` from the environment.

## Optional: AI territory lore

Set a Gemini API key on the server to enable the "Generate Territory Lore" button:

```bash
GEMINI_API_KEY=your-key npm start
```

`GEMINI_MODEL` overrides the model (default `gemini-2.5-flash`).

## Notes

- Rooms live in server memory. Restarting the server ends all games.
- An empty room is kept for 2 minutes so a host with a flaky connection can rejoin.
- If the host leaves, the longest-connected player becomes host.
