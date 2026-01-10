module.exports = {
  apps: [{
    name: 'steam-boost',
    script: 'dist/index.js',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    restart_delay: 5000,
    exp_backoff_restart_delay: 100,
    env: {
      NODE_ENV: 'production',
      // Set your secrets here (or via command line)
      // TELEGRAM_TOKEN: 'your_token',
      // ENCRYPTION_KEY: 'your_key',
      // ALLOWED_USERS: '593204492'
    },
    // Restart on crash
    min_uptime: '10s',
    max_restarts: 50,
    // Cron restart every 6 hours for stability
    cron_restart: '0 */6 * * *'
  }]
};
