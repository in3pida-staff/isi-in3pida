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
(async()=>{
  // 1. Azzera tutte le versioni
  const r1 = await sb.from('isi_plugin_versions').update({is_current:false}).gte('version','0');
  if(r1.error){console.error('ERRORE step1:',r1.error.message);process.exit(1);}
  // 2. Inserisci con is_current:false (evita trigger)
  const r2 = await sb.from('isi_plugin_versions').upsert({version:'${VERSION}',changelog:'${CHANGELOG}',download_url:'https://isi.in3pida.it/in3pida-faq-${VERSION}.zip',is_current:false,released_at:new Date().toISOString()},{onConflict:'version'});
  if(r2.error){console.error('ERRORE step2:',r2.error.message);process.exit(1);}
  // 3. Leggi l id della riga appena inserita/aggiornata
  const { data: row, error: re } = await sb.from('isi_plugin_versions').select('id').eq('version','${VERSION}').single();
  if(re||!row){console.error('ERRORE step3: versione non trovata');process.exit(1);}
  // 4. Imposta is_current:true con UPDATE separato (bypassa trigger INSERT)
  const r4 = await sb.from('isi_plugin_versions').update({is_current:true}).eq('id',row.id);
  if(r4.error){console.error('ERRORE step4:',r4.error.message);process.exit(1);}
  console.log('Supabase OK');
})();
"

echo "→ [3/4] Git add, commit, push"
cd "$SCRIPT_DIR"
git add "docs/in3pida-faq-${VERSION}.zip"
git commit -m "Plugin v${VERSION}: ${CHANGELOG}"
git push

echo ""
echo "✓ Release ${VERSION} completata:"
echo "  ZIP:      docs/in3pida-faq-${VERSION}.zip"
echo "  Supabase: is_current = true"
echo "  GitHub:   pushed"
echo "  → Aggiorna i siti manualmente dalla dashboard"
