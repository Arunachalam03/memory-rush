#!/usr/bin/env node
"use strict";
// Usage: node scripts/set-endpoint.js "<Apps Script /exec URL>" [path/to/config.js]
const fs = require("node:fs");
const path = require("node:path");

const url = process.argv[2] || "";
const file = process.argv[3] || path.join(__dirname, "..", "config.js");
const VALID = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

if (!VALID.test(url)) {
  console.error('Expected a URL like https://script.google.com/macros/s/XXXX/exec (the "Web app" URL, not the editor URL).');
  process.exit(1);
}
const src = fs.readFileSync(file, "utf8");
if (!/endpoint:\s*"[^"]*"/.test(src)) {
  console.error("Could not find the endpoint field in " + file);
  process.exit(1);
}
fs.writeFileSync(file, src.replace(/endpoint:\s*"[^"]*"/, () => 'endpoint: "' + url + '"'));
console.log("Endpoint saved to " + file + ". Now commit and push to publish.");
