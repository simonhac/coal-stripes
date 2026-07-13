# House rules

- Always use Australian English spellings such as colour, visualise, optimise instead of American English spellings (eg. color, visualize and optimize). If you see American English spelling in my code, suggest a change.

- This project has a strong separation of concerns between the client and the server.
- The server talks to OpenElectricity using the OpenElectricityClient library.
- The client never talks directly to OpenElectricity, only to our server.

- When a generating unit is inoperable (due to maintenance or outages) its capacity factor will be zero, not null/undefined.
- When a capacity factor is unknown — either because the associated date is in the future or, for dates in the past, the data collection infrastructure is faulty — this is always represented as null.
- Never interpret null as zero or vice versa. Null means "no data"; zero is a zero quantity. These are distinct concepts and must never be swapped.

- Except where necessary (ie. interfacing external code), do not use the built-in JavaScript Date object. Use Adobe's @internationalized/date, and note that we have many date functions in src/shared/date-utils.ts.

- Environment variables are defined and stored in `.env.local`.

- When searching code, prefer ast-grep for syntax-aware and structural matching (eg. `ast-grep --lang typescript -p '<pattern>'`) instead of text-only tools like rg or grep.

## Gesture library notes (@use-gesture, react-spring)

- @use-gesture's `velocity` is a speed, always >= 0. Multiply by `direction` (-1/0/1) to get the true velocity vector: `velocity[0] * direction[0]`.
- Prefer `api.start({ ..., immediate: true })` over `api.set()` — `set()` has known bugs where the spring's internal value isn't updated and it "jumps back". Use `start()` with a spring config (no `immediate`) for animated transitions after release.
- `immediate: true` doesn't cancel queued animations; call `api.stop()` first to truly halt at the current position.
- In controlled gesture components, the parent's `currentOffset` prop is the source of truth. Internal refs may only track position *during* an active gesture; always initialise a new gesture (drag start, wheel start) from the parent's `currentOffset`, never a stored ref, or the position goes stale after keyboard navigation or data loads.
