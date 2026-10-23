// Local regions. Each one is its own lobby (separate world and players) on game-server.js,
// reached at ws://<host>/play/<id> (and /play/<id>/new for a party). patch-client.ts adds them
// to the client's server list.

export const REGIONS = [
  { id: "us-east", name: "USA East", countryCode: "US", lat: 39, lon: -77 },
  { id: "us-central", name: "USA Central", countryCode: "US", lat: 41, lon: -96 },
  { id: "us-west", name: "USA West", countryCode: "US", lat: 37, lon: -122 },
  { id: "eu", name: "Europe", countryCode: "EU", lat: 50, lon: 8 },
  { id: "asia", name: "Asia", countryCode: "SG", lat: 1, lon: 104 },
  { id: "oceania", name: "Oceania", countryCode: "AU", lat: -34, lon: 151 },
  { id: "brazil", name: "Brazil", countryCode: "BR", lat: -23, lon: -46 },
];
