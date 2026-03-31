const fs = require('fs');
const path = require('path');
const { findSteamInstall } = require('./src/core/steamHelpers');

const steamPath = findSteamInstall();
const configPath = path.join(steamPath, 'config', 'config.vdf');

if (fs.existsSync(configPath)) {
  const content = fs.readFileSync(configPath, 'utf-8');
  console.log('Config length:', content.length);
  const match = content.match(/"Software"\s*\{\s*"Valve"\s*\{\s*"Steam"\s*\{/i);
  if (match) {
    console.log('Found Software -> Valve -> Steam');
    
    // Check if "depots" node exists
    if (!content.includes('"depots"')) {
      console.log('No depots node found. Need to inject it.');
    } else {
      console.log('Depots node exists.');
    }
  } else {
    console.log('Root not found.');
  }
} else {
  console.log('Config not found at', configPath);
}
