module.exports = {
  apps: [{
    name:             'vidbot',
    script:           'src/index.js',
    watch:            false,
    max_memory_restart: '1500M',   
    max_restarts:     10,
    min_uptime:       '10s',
    restart_delay:    3000,
    env: {
      NODE_ENV: 'production',
    },
    log_date_format:  'YYYY-MM-DD HH:mm:ss',
  }]
}