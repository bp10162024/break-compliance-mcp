// Break Compliance MCP — exposes the PBI 12985 knowledge base as MCP tools.
// Auth via Authorization: Bearer ${MCP_BEARER}.
// Health check at GET /.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const ws = require('ws');

const PORT          = process.env.PORT || 3000;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const OPENAI_API_KEY= process.env.OPENAI_API_KEY;
const MCP_BEARER    = process.env.MCP_BEARER;

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('SUPABASE_URL and SUPABASE_KEY required'); process.exit(1); }
if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY required'); process.exit(1); }
if (!MCP_BEARER) { console.warn('MCP_BEARER not set — service will run open. Set it before exposing publicly.'); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const EMBED_MODEL = 'text-embedding-3-small';

async function embed(text) {
  const r = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
  return r.data[0].embedding;
}

async function backfillEmbeddings() {
  const { data, error } = await supabase
    .from('break_compliance_chunks')
    .select('id, title, content')
    .is('embedding', null)
    .limit(500);
  if (error) { console.error('backfill list failed', error); return; }
  if (!data || data.length === 0) { console.log('no embeddings to backfill'); return; }
  console.log(`backfilling embeddings for ${data.length} chunks...`);
  for (const row of data) {
    try {
      const text = `${row.title}\n\n${row.content}`;
      const vec = await embed(text);
      const { error: upErr } = await supabase
        .from('break_compliance_chunks')
        .update({ embedding: vec, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      if (upErr) console.error(`embed update failed for id=${row.id}`, upErr);
      else console.log(`  embedded ${row.id}`);
    } catch (e) {
      console.error(`embed failed for id=${row.id}`, e.message);
    }
  }
  console.log('backfill complete');
}

const TOOLS = [
  { name: 'search_break_compliance', description: 'Semantic search over the Buddy Punch Break Compliance knowledge base (PBI 12985). Returns the most relevant chunks (features, scenarios, decisions, case law, open questions) for a free-text query. Use this for any question about the design.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', default: 6 }, chunk_type: { type: 'string', enum: ['feature','scenario','case_law','mockup','decision','open_question','section','reference'] } }, required: ['query'] } },
  { name: 'get_break_compliance_by_slug', description: 'Retrieve a single Break Compliance chunk by its slug.', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
  { name: 'list_break_compliance_slugs', description: 'List all Break Compliance chunks by slug and title.', inputSchema: { type: 'object', properties: { chunk_type: { type: 'string', enum: ['feature','scenario','case_law','mockup','decision','open_question','section','reference'] } } } },
  { name: 'get_open_questions', description: 'Return all open questions for the Break Compliance build.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_case_law', description: 'Return all California case-law constraints relevant to the Break Compliance build.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_scenarios', description: 'Return all 22 scenarios from Section 9.', inputSchema: { type: 'object', properties: {} } },
];

async function handleToolCall(name, args = {}) {
  args = args || {};
  if (name === 'search_break_compliance') {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query is required');
    const limit = Math.min(Math.max(parseInt(args.limit) || 6, 1), 20);
    const chunkType = args.chunk_type || null;
    const queryEmbedding = await embed(query);
    const { data, error } = await supabase.rpc('search_break_compliance', { query_embedding: queryEmbedding, match_count: limit, filter_chunk_type: chunkType });
    if (error) throw new Error(`search failed: ${error.message}`);
    return { results: data || [] };
  }
  if (name === 'get_break_compliance_by_slug') {
    const slug = String(args.slug || '').trim();
    if (!slug) throw new Error('slug is required');
    const { data, error } = await supabase.rpc('get_break_compliance_by_slug', { slug_in: slug });
    if (error) throw new Error(`lookup failed: ${error.message}`);
    if (!data || data.length === 0) return { found: false };
    return { found: true, chunk: data[0] };
  }
  if (name === 'list_break_compliance_slugs') {
    const chunkType = args.chunk_type || null;
    const { data, error } = await supabase.rpc('list_break_compliance_slugs', { filter_chunk_type: chunkType });
    if (error) throw new Error(`list failed: ${error.message}`);
    return { items: data || [] };
  }
  if (name === 'get_open_questions') {
    const { data, error } = await supabase.from('break_compliance_chunks').select('slug, title, content, metadata').eq('chunk_type', 'open_question').order('slug');
    if (error) throw new Error(error.message);
    const caseLawDriven = (data || []).filter(r => (r.metadata || {}).category === 'case-law-driven');
    const businessChoice = (data || []).filter(r => (r.metadata || {}).category === 'business-choice');
    return { case_law_driven: caseLawDriven, business_choice: businessChoice };
  }
  if (name === 'get_case_law') {
    const { data, error } = await supabase.from('break_compliance_chunks').select('slug, title, content, metadata, source_section').eq('chunk_type', 'case_law').order('slug');
    if (error) throw new Error(error.message);
    return { items: data || [] };
  }
  if (name === 'get_scenarios') {
    const { data, error } = await supabase.from('break_compliance_chunks').select('slug, title, content, metadata').eq('chunk_type', 'scenario').order('slug');
    if (error) throw new Error(error.message);
    return { items: data || [] };
  }
  throw new Error(`Unknown tool: ${name}`);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'break-compliance-mcp', tools: TOOLS.map(t => t.name) });
});

function checkAuth(req, res) {
  if (!MCP_BEARER) return true;
  const h = req.headers.authorization || '';
  if (h === `Bearer ${MCP_BEARER}`) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { id, method, params } = req.body || {};
  try {
    if (method === 'initialize') return res.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'break-compliance-mcp', version: '0.1.2' }, capabilities: { tools: {} } } });
    if (method === 'tools/list') return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      const result = await handleToolCall(name, args);
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    }
    res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});

app.post('/admin/reembed-all', async (req, res) => {
  if (!checkAuth(req, res)) return;
  await supabase.from('break_compliance_chunks').update({ embedding: null }).gt('id', 0);
  setImmediate(backfillEmbeddings);
  res.json({ ok: true, status: 'reembed scheduled' });
});

app.post('/admin/backfill', async (req, res) => {
  if (!checkAuth(req, res)) return;
  setImmediate(backfillEmbeddings);
  res.json({ ok: true, status: 'backfill scheduled' });
});

// Explicitly bind to 0.0.0.0 — Railway edge can't reach a service bound to ::1.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`break-compliance-mcp listening on 0.0.0.0:${PORT}`);
  backfillEmbeddings().catch(e => console.error('initial backfill failed', e));
});
