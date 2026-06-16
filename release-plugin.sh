#!/bin/bash
# USO: ./release-plugin.sh 2.4.7 "Descrizione del rilascio"
set -e

VERSION="$1"
CHANGELOG="$2"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ -z "$VERSION" ] || [ -z "$CHANGELOG" ]; then
  echo "USO: ./release-plugin.sh <versione> \"<changelog>\""
  echo "ESEMPIO: ./release-plugin.sh 2.4.7 \"Aggiunto sistema permessi\""
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ERRORE: file .env non trovato in $SCRIPT_DIR"
  exit 1
fi
source "$ENV_FILE"

SERVICE_KEY="${SUPABASE_SERVICE_KEY}"
SOURCE_ZIP="/Users/mariodamore/Desktop/in3pida sito intelligente/in3pida-faq-${VERSION}.zip"
DOCS_ZIP="$SCRIPT_DIR/docs/in3pida-faq-${VERSION}.zip"

if [ ! -f "$SOURCE_ZIP" ]; then
  echo "ERRORE: ZIP non trovato: $SOURCE_ZIP"
  exit 1
fi

echo "→ [1/4] Copio ZIP in docs/"
cp "$SOURCE_ZIP" "$DOCS_ZIP"

echo "→ [2/4] Aggiorno Supabase (is_current)"
node -e "
const { createClient } = require('@supabase/supabase-js');
const sb = createClient('${SUPABASE_URL}','${SERVICE_KEY}',{auth:{persistSession:false}});
sb.from('isi_plugin_versions').update({is_current:false}).neq('version','${VERSION}').then(()=>
sb.from('isi_plugin_versions').upsert({version:'${VERSION}',changelog:'${CHANGELOG}',download_url:'https://isi.in3pida.it/in3pida-faq-${VERSION}.zip',is_current:true,released_at:new Date().toISOString()},{onConflict:'version'}).then(r=>{
  if(r.error){console.error('ERRORE Supabase:',r.error.message);process.exit(1);}
  else{console.log('Supabase OK');}
}));
"

echo "→ [3/4] Git add, commit, push"
cd "$SCRIPT_DIR"
git add "docs/in3pida-faq-${VERSION}.zip"
git commit -m "Plugin v${VERSION}: ${CHANGELOG}"
git push

echo "→ [4/4] Trigger aggiornamento automatico su tutti i siti"
node -e "
fetch('${SUPABASE_URL}/functions/v1/isi-trigger-update', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ${SERVICE_KEY}', 'apikey': '${SERVICE_KEY}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ all: true })
}).then(r=>r.json()).then(d=>{
  if (!d.results) { console.log('Trigger risposta:', JSON.stringify(d)); return; }
  d.results.forEach(s => {
    const stato = s.ok ? 'OK' : ('ERRORE: ' + (s.error || s.message || ''));
    console.log('  ' + (s.site_name||s.site_id) + ' → ' + stato);
  });
}).catch(e=>console.log('Trigger fallito (non bloccante):', e.message));
"

echo ""
echo "✓ Release ${VERSION} completata:"
echo "  ZIP:      docs/in3pida-faq-${VERSION}.zip"
echo "  Supabase: is_current = true"
echo "  GitHub:   pushed"
echo "  Siti:     aggiornamento inviato a tutti"
