# Troubleshooting Guide

## Common Errors and Solutions

### ❌ Error 401: "Request failed with status code 401"

**Cause**: Authentication is failing with Kalshi API

**Solutions**:
1. **Check your API credentials**:
   ```bash
   cat .env
   # Make sure KALSHI_API_KEY and KALSHI_API_SECRET are correct
   ```

2. **Get fresh credentials**:
   - Go to https://kalshi.com/settings/api
   - Create a new API key
   - Make sure to enable "Trading" permissions
   - Copy BOTH the key and secret to your `.env` file

3. **Format check**:
   ```env
   # .env file should look like this:
   KALSHI_API_KEY=abc123...
   KALSHI_API_SECRET=xyz789...
   
   # NO spaces around the = sign
   # NO quotes around the values
   ```

4. **Restart the bot** after changing `.env`:
   ```bash
   # Stop bot (Ctrl+C)
   # Start again
   npm start
   ```

### ❌ Error 404: "Request failed with status code 404"

**Cause**: Depends heavily on which endpoint returned the 404.

- **`GET /trade-api/v2/markets/<ticker>`** — the contract genuinely doesn't
  exist yet. Kalshi creates these contracts dynamically, so this is normal
  during the first few minutes of a new 15-min window. The bot skips these
  and discovers the valid ones automatically.
- **Order placement (`POST /trade-api/v2/portfolio/events/orders`)** —
  if you get 404, the request is hitting the wrong host.
  `api.elections.kalshi.com` is the consumer site and 404s on *every*
  `/trade-api/v2/*` path (orders, balance, markets). The production REST host
  is `https://external-api.kalshi.com` (see
  [Kalshi docs](https://docs.kalshi.com/welcome)). If your `KALSHI_API_BASE`
  is set to anything other than `external-api.kalshi.com`, that's the cause.
- **Order status check (`GET /trade-api/v2/portfolio/orders/<order_id>`)** —
  if you get 404, the order ID may be invalid or the order was never created.
  Note: The V2 single-order GET is at `/portfolio/orders/{id}` (NOT
  `/portfolio/events/orders/{id}` which 404s on reads).
- **Order cancellation (`DELETE /trade-api/v2/portfolio/events/orders/<order_id>`)** —
  if you get 404, the order may already be fully filled/canceled/expired, or
  the ID is invalid.

**Solution**:
- Market-data 404s: ✅ expected, wait 1-2 minutes.
- Order 404s: set `KALSHI_API_BASE=https://external-api.kalshi.com` in
  `.env` and restart the bot.
- Single-order GET 404: verify the order ID is correct; use
  `GET /trade-api/v2/portfolio/orders?limit=100` to list all orders.
- Cancel 404: order already settled; no action needed.

The bot discovers contracts like:
- `KXBTC15M-12FEB224500` (future contract, not created yet)
- `KXBTC15M-12FEB230000` (exists, will trade)

### ⚠️ "Error fetching Polymarket price"

**Cause**: Polymarket API integration is temporarily disabled in the code

**Current Status**:
The bot is using **simulated Polymarket prices** for testing. This is intentional and safe.

**To enable real Polymarket data**:
1. Map Kalshi contracts to Polymarket token IDs
2. Update the `fetchPolymarketPrice()` function
3. Uncomment the production code in that function

### 🔧 How to Test Your Setup

Run this test to verify your Kalshi API works:

```bash
# Create test file: test-kalshi.js
cat > test-kalshi.js << 'EOF'
require('dotenv').config();
const axios = require('axios');

// Easiest path: reuse the bot's own KalshiClient, which already does the
// RSA-PSS request signing (KALSHI-ACCESS-KEY/SIGNATURE/TIMESTAMP).
const KalshiClient = require('./bot/kalshi');

const client = new KalshiClient({
  KALSHI_API_KEY: process.env.KALSHI_API_KEY,
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem',
  // Per Kalshi docs, the production REST host is external-api.kalshi.com.
  KALSHI_API_BASE: process.env.KALSHI_API_BASE || 'https://external-api.kalshi.com',
}, {});

async function testKalshi() {
  try {
    const balance = await client.fetchBalance();
    console.log('✅ SUCCESS! Balance:', balance);
  } catch (error) {
    console.log('❌ FAILED:', error.response?.status, error.response?.data || error.message);
  }
}

testKalshi();
EOF

# Run the test
node test-kalshi.js
```

**Expected output**:
```
✅ SUCCESS! Balance: { balance: 500000, payout: 0 }
```

If you see 401 error, your API key is wrong.

### 🐛 Enable Debug Mode

Add this to your `.env` to see more details:

```env
DEBUG=true
NODE_ENV=development
```

### 📊 Understanding the Logs

**Normal startup sequence**:
```
[SUCCESS] 🤖 Starting Kalshi Rolling Contracts Bot
[INFO] Testing Kalshi API connection...
[SUCCESS] Balance: $5000.00 ($5000.00 available)
[SUCCESS] ✅ Kalshi API connected successfully
[SUCCESS] 📋 Discovered contract: KXBTC15M-...
[INFO] Bot is running. Press Ctrl+C to stop.
```

**What each error means**:
- `401` = Bad API credentials
- `404` = Contract doesn't exist (normal for future contracts)
- `429` = Rate limited (too many requests)
- `500` = Kalshi server error (try again later)

### 🔑 Getting API Credentials

1. Log in to https://kalshi.com
2. Click your profile → Settings
3. Go to "API Keys" section
4. Click "Create New API Key"
5. **Enable "Trading" permission**
6. Copy both Key and Secret immediately
7. Paste into `.env` file

### 💡 Quick Fixes

**Bot won't start**:
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Check Node version (need 16+)
node --version
```

**Still getting 401 errors**:
```bash
# Regenerate your API key on Kalshi
# Delete the old one
# Create a new one
# Update .env file
```

**No contracts found**:
```bash
# Wait 2-3 minutes for Kalshi to create the next 15min contract
# The bot will auto-discover it
```

### 📞 Need More Help?

Check the Kalshi API documentation:
https://docs.kalshi.com/welcome

Or check your API key status:
https://kalshi.com/settings/api