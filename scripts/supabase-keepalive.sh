#!/bin/bash
# Supabase Keepalive - pings the database every 5 minutes to prevent sleeping

SUPABASE_URL="https://ylwnolxvsfyetgdbkcnu.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlsd25vbHh2c2Z5ZXRnZGJrY251Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0NTk5NTUsImV4cCI6MjA4NzAzNTk1NX0.FwAowBFX1w_YrlvW5lm68d-eCgnYS4Uochlh98PS_2c"

RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  "${SUPABASE_URL}/rest/v1/" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  --max-time 10)

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

if [ "$RESPONSE" -eq 200 ]; then
  echo "${TIMESTAMP} - OK (${RESPONSE})"
else
  echo "${TIMESTAMP} - FAILED (${RESPONSE})"
fi
