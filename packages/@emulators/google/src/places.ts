import type { AppEnv, Entity, Hono, Store } from "@emulators/core";

export interface GooglePlaceSeed {
  place_id: string;
  formatted_address: string;
  aliases?: string[];
  latitude: number;
  longitude: number;
  time_zone_id: string;
  raw_offset: number;
  dst_offset: number;
  address_components: Array<{ long_name: string; short_name: string; types: string[] }>;
}

export interface GooglePlace extends Entity, GooglePlaceSeed {
  aliases: string[];
}

export function getPlaces(store: Store) {
  return store.collection<GooglePlace>("google.places", ["place_id"]);
}

export function seedPlaces(store: Store, places: GooglePlaceSeed[]): void {
  const collection = getPlaces(store);
  for (const place of places) {
    if (
      !place.place_id ||
      !place.formatted_address ||
      !Number.isFinite(place.latitude) ||
      !Number.isFinite(place.longitude) ||
      !Number.isFinite(place.raw_offset) ||
      !Number.isFinite(place.dst_offset) ||
      !place.time_zone_id ||
      !place.address_components.length
    ) {
      throw new Error("Places require an ID, address, coordinates, time zone and address components");
    }
    const data = { ...place, aliases: place.aliases ?? [] };
    const existing = collection.findOneBy("place_id", place.place_id);
    if (existing) collection.update(existing.id, data);
    else collection.insert(data);
  }
}

function matches(place: GooglePlace, input: string): boolean {
  const words = input.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return [place.formatted_address, ...place.aliases].some((value) =>
    words.every((word) => value.toLowerCase().includes(word)),
  );
}

function result(place: GooglePlace) {
  return {
    place_id: place.place_id,
    formatted_address: place.formatted_address,
    address_components: place.address_components,
    geometry: { location: { lat: place.latitude, lng: place.longitude } },
  };
}

export function placesRoutes(app: Hono<AppEnv>, store: Store): void {
  app.get("/maps/api/js", (c) =>
    c.text(browserScript, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    }),
  );
  app.get("/maps/api/place/autocomplete/json", (c) => {
    const input = c.req.query("input") ?? "";
    if (!input.trim()) return c.json({ predictions: [], status: "INVALID_REQUEST" });
    const predictions = getPlaces(store)
      .all()
      .filter((place) => matches(place, input))
      .map((place) => ({
        description: place.formatted_address,
        place_id: place.place_id,
      }));
    return c.json({ predictions, status: predictions.length ? "OK" : "ZERO_RESULTS" });
  });
  app.get("/maps/api/place/details/json", (c) => {
    const place = getPlaces(store).findOneBy("place_id", c.req.query("place_id") ?? "");
    return c.json(place ? { result: result(place), status: "OK" } : { result: null, status: "NOT_FOUND" });
  });
  app.get("/maps/api/geocode/json", (c) => {
    const address = c.req.query("address") ?? "";
    const results = getPlaces(store)
      .all()
      .filter((place) => matches(place, address))
      .map(result);
    return c.json({ results, status: results.length ? "OK" : "ZERO_RESULTS" });
  });
  app.get("/maps/api/timezone/json", (c) => {
    const location = c.req.query("location")?.split(",").map(Number);
    if (!location || location.length !== 2 || location.some((value) => !Number.isFinite(value))) {
      return c.json({ status: "INVALID_REQUEST" });
    }
    const place = getPlaces(store)
      .all()
      .find((item) => Math.abs(item.latitude - location[0]) < 0.001 && Math.abs(item.longitude - location[1]) < 0.001);
    return c.json(
      place
        ? {
            status: "OK",
            timeZoneId: place.time_zone_id,
            timeZoneName: place.time_zone_id,
            rawOffset: place.raw_offset,
            dstOffset: place.dst_offset,
          }
        : { status: "ZERO_RESULTS" },
    );
  });
}

const browserScript = String.raw`(function () {
  const origin = new URL(document.currentScript.src).origin;
  const maps = window.google = window.google || {};
  maps.maps = maps.maps || {};
  function location(value) { return { lat: () => value.lat, lng: () => value.lng }; }
  function place(value) { return { ...value, geometry: { location: location(value.geometry.location) } }; }
  async function api(path, params) {
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url);
    if (!response.ok) throw new Error('Places API request failed');
    return response.json();
  }
  class Autocomplete {
    constructor(input) {
      this.input = input;
      this.listeners = new Map();
      this.selected = null;
      this.container = document.createElement('div');
      this.container.className = 'pac-container';
      this.container.style.cssText = 'position:absolute;background:white;z-index:10000;box-shadow:0 2px 8px #aaa;padding:8px';
      document.body.appendChild(this.container);
      input.addEventListener('input', () => { this.update().catch(() => { this.container.replaceChildren(); }); });
    }
    setFields(fields) { this.fields = fields; }
    addListener(name, callback) {
      const callbacks = this.listeners.get(name) || [];
      callbacks.push(callback); this.listeners.set(name, callbacks);
      return { remove: () => this.listeners.set(name, callbacks.filter(value => value !== callback)) };
    }
    getPlace() { return this.selected; }
    async update() {
      const query = this.input.value;
      if (!query.trim()) { this.container.replaceChildren(); return; }
      const data = await api('/maps/api/place/autocomplete/json', { input: query });
      if (this.input.value !== query) return;
      this.container.replaceChildren();
      const rect = this.input.getBoundingClientRect();
      this.container.style.left = (rect.left + window.scrollX) + 'px';
      this.container.style.top = (rect.bottom + window.scrollY) + 'px';
      this.container.style.width = rect.width + 'px';
      for (const prediction of data.predictions) {
        const item = document.createElement('div');
        item.className = 'pac-item'; item.textContent = prediction.description;
        item.style.cssText = 'cursor:pointer;padding:6px';
        item.addEventListener('mousedown', event => event.preventDefault());
        item.addEventListener('click', async () => {
          const details = await api('/maps/api/place/details/json', { place_id: prediction.place_id });
          if (details.status !== 'OK') return;
          this.selected = place(details.result);
          for (const callback of this.listeners.get('place_changed') || []) callback();
          this.input.value = this.selected.formatted_address;
          this.container.replaceChildren();
        });
        this.container.appendChild(item);
      }
    }
  }
  maps.maps.places = { Autocomplete };
  maps.maps.GeocoderStatus = { OK: 'OK', ZERO_RESULTS: 'ZERO_RESULTS' };
  maps.maps.Geocoder = class {
    geocode(request, callback) {
      api('/maps/api/geocode/json', { address: request.address || '' })
        .then(data => callback(data.results.map(place), data.status))
        .catch(() => callback([], 'UNKNOWN_ERROR'));
    }
  };
})();`;
