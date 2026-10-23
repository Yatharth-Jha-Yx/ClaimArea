# GeoQuest

A real-world GPS territory game. Walk a loop to capture the area inside it. Cross another player's live path to cut it and steal +10 points.

**Closing a loop:** press Start, walk around a block, and come back within 20 m of where you started (or cross your own trail). The map shows your start point, a dashed line back to it, and a preview of the area you'll claim. Loops must enclose at least 100 m².

**Owning land:** claimed land is filled with your color. A loop that overlaps another player's land takes that part (it turns your color, and they lose the points for it). A loop that overlaps your own land merges with it. You score 1 point per 100 m² of new land, plus 10 for cutting someone's live trail.

**Sharing a run:** when you stop a run you get a summary (distance, time, pace, area claimed, points, calories). Tap **Share to story** to make a Strava-style 1080×1920 story image: pick a photo (or a plain background, or a transparent sticker), add a caption, choose where the stats sit, then share it straight to Instagram or save it. Calories and steps are estimates from distance and pace. **Share last run** in the panel reopens it later.

Keep the game open while you walk: the screen stays on automatically during a run, because phones pause GPS for locked or background browser tabs.

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
- The map uses OpenStreetMap's standard tiles (no API key), restyled with a CSS filter to match the device's light or dark mode. OSM's free tile server is for light use; for a bigger launch, switch `TILE_URL` in `geoquest_Version4.html` to a paid provider.
