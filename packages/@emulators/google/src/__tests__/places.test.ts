import { describe, expect, it } from "vitest";
import { createServer } from "@emulators/core";
import { getPlaces, googlePlugin, seedFromConfig, type GooglePlaceSeed } from "../index.js";

const place: GooglePlaceSeed = {
  place_id: "place_townsend",
  formatted_address: "410 Townsend St, San Francisco, CA 94107, USA",
  aliases: ["410 Townsend Street, San Francisco"],
  latitude: 37.7751,
  longitude: -122.3986,
  time_zone_id: "America/Los_Angeles",
  raw_offset: -28800,
  dst_offset: 3600,
  address_components: [
    { long_name: "410", short_name: "410", types: ["street_number"] },
    { long_name: "Townsend Street", short_name: "Townsend St", types: ["route"] },
    { long_name: "San Francisco", short_name: "San Francisco", types: ["locality"] },
    { long_name: "California", short_name: "CA", types: ["administrative_area_level_1"] },
    { long_name: "United States", short_name: "US", types: ["country"] },
    { long_name: "94107", short_name: "94107", types: ["postal_code"] },
  ],
};

describe("Google Places", () => {
  it("serves the browser SDK and seeded autocomplete, details, geocode and time zone", async () => {
    const { app, store } = createServer(googlePlugin);
    seedFromConfig(store, "http://localhost:4000", { places: [place] });
    seedFromConfig(store, "http://localhost:4000", { places: [place] });
    expect(getPlaces(store).all()).toHaveLength(1);

    const script = await app.request("/maps/api/js?libraries=places");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("application/javascript");
    expect(await script.text()).toContain("maps.maps.places = { Autocomplete }");

    const predictions = await app.request("/maps/api/place/autocomplete/json?input=410%20Townsend%20Street");
    expect(predictions.headers.get("access-control-allow-origin")).toBe("*");
    expect(await predictions.json()).toMatchObject({ status: "OK", predictions: [{ place_id: place.place_id }] });

    const details = await app.request(`/maps/api/place/details/json?place_id=${place.place_id}`);
    expect(await details.json()).toMatchObject({
      status: "OK",
      result: {
        formatted_address: place.formatted_address,
        geometry: { location: { lat: place.latitude, lng: place.longitude } },
        address_components: place.address_components,
      },
    });
    const geocode = await app.request("/maps/api/geocode/json?address=410%20Townsend%20Street");
    expect(await geocode.json()).toMatchObject({ status: "OK", results: [{ place_id: place.place_id }] });
    const timezone = await app.request(`/maps/api/timezone/json?location=${place.latitude},${place.longitude}`);
    expect(await timezone.json()).toMatchObject({
      status: "OK",
      timeZoneId: place.time_zone_id,
      rawOffset: place.raw_offset,
      dstOffset: place.dst_offset,
    });

    const snapshot = store.snapshot();
    store.restore(snapshot);
    expect(getPlaces(store).findOneBy("place_id", place.place_id)?.formatted_address).toBe(place.formatted_address);
  });

  it("returns bounded failures for unknown or malformed locations", async () => {
    const { app, store } = createServer(googlePlugin);
    seedFromConfig(store, "http://localhost:4000", { places: [place] });
    expect(await (await app.request("/maps/api/place/autocomplete/json?input=unknown")).json()).toMatchObject({
      status: "ZERO_RESULTS",
      predictions: [],
    });
    expect(await (await app.request("/maps/api/place/details/json?place_id=missing")).json()).toMatchObject({
      status: "NOT_FOUND",
      result: null,
    });
    expect(await (await app.request("/maps/api/timezone/json?location=invalid")).json()).toMatchObject({
      status: "INVALID_REQUEST",
    });
    expect(() => seedFromConfig(store, "http://localhost:4000", { places: [{ ...place, latitude: NaN }] })).toThrow(
      /coordinates/,
    );
  });
});
