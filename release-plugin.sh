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
SOURCE_ZIP="/Users/mariodamore/Desktop/in3pida sito intelligente/eletta-${VERSION}.zip"
DOCS_ZIP="$SCRIPT_DIR/docs/eletta-${VERSION}.zip"

if [ ! -f "$SOURCE_ZIP" ]; then
  echo "ERRORE: ZIP non trovato: $SOURCE_ZIP"
  exit 1
fi

echo "→ [1/4] Copio ZIP in docs/"
cp "$SOURCE_ZIP" "$DOCS_ZIP"

echo "→ [2/4] Aggiorno Supabase"
node -e "
const { createClient } = require('@supabase/supabase-js');
const sb = createClient('${SUPABASE_URL}','${SERVICE_KEY}',{auth:{persistSession:false}});
(async()=>{
  // Azzera is_current su tutto, poi upsert nuova versione con is_current:true
  await sb.from('isi_plugin_versions').update({is_current:false}).gte('version','0');
  const r = await sb.from('isi_plugin_versions').upsert({
    version:'${VERSION}',
    changelog:'${CHANGELOG}',
    download_url:'https://app.eletta-ai.it/eletta-${VERSION}.zip',
    is_current:true,
    released_at:new Date().toISOString()
  },{onConflict:'version'});
  if(r.error){console.error('ERRORE upsert:',r.error.message);process.exit(1);}
  // Verifica che is_current sia rimasto true (il trigger DB potrebbe resettarlo)
  const {data:chk}=await sb.from('isi_plugin_versions').select('version,is_current').eq('version','${VERSION}').single();
  if(!chk?.is_current){
    // Trigger ha resettato — forza con PATCH separato
    await sb.from('isi_plugin_versions').update({is_current:true}).eq('version','${VERSION}');
  }
  console.log('Supabase OK — versione ${VERSION} corrente');
})();
"

echo "→ [3/4] Git add, commit, push"
cd "$SCRIPT_DIR"
git add "docs/eletta-${VERSION}.zip"
git commit -m "Plugin v${VERSION}: ${CHANGELOG}"
git push

echo ""
echo "✓ Release ${VERSION} completata:"
echo "  ZIP:      docs/eletta-${VERSION}.zip"
echo "  Supabase: is_current = true"
echo "  GitHub:   pushed"
echo "  → Aggiorna i siti manualmente dalla dashboard"
