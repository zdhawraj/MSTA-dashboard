// update-metrics.js - Fetches MSTA metrics and generates dashboard HTML
// Runs in GitHub Actions daily

const https = require('https');
const fs = require('fs');

const API_BASE = 'https://mplzkytosro4pheey25n6zhrxu0hehii.lambda-url.us-east-1.on.aws';
const NODE = 'MSTA';
const CRITICAL_FNS = ['Scanner','Loading-Scanner','Fluid Sorting','Secondary Sorter','ZBS','Primary Sorter','Problem Solve','Sort Slide'];
const PLANNED_HC = 14;

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Parse error: ' + url)); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const today = new Date().toISOString().split('T')[0];
  const fetchTime = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`=== MSTA Metrics - ${today} ===`);

  // Fetch data
  console.log('Fetching data...');
  const [wfData, certs, coachData, psData, configData] = await Promise.all([
    fetch(`${API_BASE}/api/data`),
    fetch(`${API_BASE}/api/certifications`),
    fetch(`${API_BASE}/api/coaching`),
    fetch(`${API_BASE}/api/scan/ps-deployment`),
    fetch(`${API_BASE}/api/config`)
  ]);

  const mstaWf = wfData.a.filter(a => a.s === NODE);
  const ftpt = mstaWf.filter(a => a.t === 'Direct' || a.t === 'Direct-PT');
  const ft = mstaWf.filter(a => a.t === 'Direct');
  const pt = mstaWf.filter(a => a.t === 'Direct-PT');
  const alfa = mstaWf.filter(a => a.t === 'ALFA');
  console.log(`  Associates: ${mstaWf.length} (FT+PT:${ftpt.length} ALFA:${alfa.length})`);

  // Tenured cutoff (>28 days)
  const metricDate = new Date(today);
  const cutoff = new Date(metricDate);
  cutoff.setDate(cutoff.getDate() - 29);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const tenuredFtpt = ftpt.filter(a => a.d < cutoffStr);
  const tenuredAlfa = alfa.filter(a => a.d < cutoffStr);

  // 1. FT+PT Ramp-Up (LC>=5 in primary)
  let ftptRamped = 0;
  ftpt.forEach(a => {
    const pr = (a.r || []).find(r => r[0] === a.pf);
    if (pr && pr[2] >= 5) ftptRamped++;
  });
  const ftptPct = ftpt.length > 0 ? +(ftptRamped / ftpt.length * 100).toFixed(1) : 0;

  // 1b. Tenured FT+PT Ramp-Up
  let tenuredRamped = 0;
  tenuredFtpt.forEach(a => {
    const pr = (a.r || []).find(r => r[0] === a.pf);
    if (pr && pr[2] >= 5) tenuredRamped++;
  });
  const tenuredPct = tenuredFtpt.length > 0 ? +(tenuredRamped / tenuredFtpt.length * 100).toFixed(1) : 0;

  // 2. ALFA Ramp-Up (Tenured, LC>=3)
  let alfaRamped = 0, alfaCritRamped = 0, alfaCritCount = 0;
  tenuredAlfa.forEach(a => {
    const pr = (a.r || []).find(r => r[0] === a.pf);
    const ramped = pr && pr[2] >= 3;
    if (ramped) alfaRamped++;
    if (CRITICAL_FNS.includes(a.pf)) {
      alfaCritCount++;
      if (ramped) alfaCritRamped++;
    }
  });
  const alfaPct = tenuredAlfa.length > 0 ? +(alfaRamped / tenuredAlfa.length * 100).toFixed(1) : 0;
  const alfaCritPct = alfaCritCount > 0 ? +(alfaCritRamped / alfaCritCount * 100).toFixed(1) : 0;
  const alfaCritPoolPct = tenuredAlfa.length > 0 ? +(alfaCritCount / tenuredAlfa.length * 100).toFixed(1) : 0;

  // 3. Cross-Training (LC>=3 in secondary, tenured FT+PT)
  let ctRamped = 0;
  ftpt.forEach(a => {
    if (a.sf) {
      const sr = (a.r || []).find(r => r[0] === a.sf);
      if (sr && sr[2] >= 3) ctRamped++;
    }
  });
  const ctPct = ftpt.length > 0 ? +(ctRamped / ftpt.length * 100).toFixed(1) : 0;

  // 3b. FT+PT Critical Pool
  const ftCrit = ft.filter(a => CRITICAL_FNS.includes(a.pf));
  const ptCrit = pt.filter(a => CRITICAL_FNS.includes(a.pf));
  const ftptCrit = ftpt.filter(a => CRITICAL_FNS.includes(a.pf));
  const ftCritPct = ft.length > 0 ? +(ftCrit.length / ft.length * 100).toFixed(1) : 0;
  const ptCritPct = pt.length > 0 ? +(ptCrit.length / pt.length * 100).toFixed(1) : 0;
  const ftptCritPct = ftpt.length > 0 ? +(ftptCrit.length / ftpt.length * 100).toFixed(1) : 0;

  // 4. Coaching (current week Sun-Sat)
  const dow = metricDate.getDay();
  const weekStart = new Date(metricDate);
  weekStart.setDate(metricDate.getDate() - dow);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const wsStr = weekStart.toISOString().split('T')[0];
  const weStr = weekEnd.toISOString().split('T')[0];

  const mstaCoaching = (coachData.data || []).filter(c => c.site === NODE || c.coach === 'jaygamit');
  const weekCoaching = mstaCoaching.filter(c => c.date >= wsStr && c.date <= weStr);
  const coachCompleted = weekCoaching.filter(c => c.status === 'completed').length;
  const coachPending = weekCoaching.filter(c => c.status === 'pending').length;
  let coachTarget = 210;
  const coachPct = coachTarget > 0 ? +(coachCompleted / coachTarget * 100).toFixed(1) : 0;

  // 5. PS Deployment (D-1)
  const d1Date = new Date(metricDate);
  d1Date.setDate(d1Date.getDate() - 1);
  const d1Str = d1Date.toISOString().split('T')[0];
  const mstaPs = psData.data && psData.data[NODE] ? psData.data[NODE] : {};
  const psDate = mstaPs[d1Str] ? d1Str : (mstaPs[today] ? today : Object.keys(mstaPs).sort().pop() || '');
  const psEntries = mstaPs[psDate] || [];
  const actualHC = psEntries.length;
  let certifiedHC = 0;
  const certAssoc = certs.associates || {};
  psEntries.forEach(entry => {
    const assoc = mstaWf.find(a => a.e === entry[0]);
    if (assoc) {
      const cert = certAssoc[assoc.a];
      if (cert && cert.type === 'PS' && cert.status === 'Completed') certifiedHC++;
    }
  });
  const deployPct = PLANNED_HC > 0 ? Math.round(certifiedHC / PLANNED_HC * 100) : 0;

  // 6. PS Availability & Rotation
  const psPool = mstaWf.filter(a => {
    const cert = certAssoc[a.a];
    return cert && cert.type === 'PS' && cert.status === 'Completed';
  });
  const psPoolCount = psPool.length;

  // Rotation: PS-cert deployed at least once in previous full week
  const prevWeekStart = new Date(weekStart);
  prevWeekStart.setDate(prevWeekStart.getDate() - 7);
  const prevWeekEnd = new Date(prevWeekStart);
  prevWeekEnd.setDate(prevWeekStart.getDate() + 6);
  let rotated = new Set();
  for (let d = new Date(prevWeekStart); d <= prevWeekEnd; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().split('T')[0];
    const entries = mstaPs[ds] || [];
    entries.forEach(e => {
      const assoc = mstaWf.find(a => a.e === e[0]);
      if (assoc && certAssoc[assoc.a] && certAssoc[assoc.a].type === 'PS') rotated.add(e[0]);
    });
  }
  const rotatedCount = rotated.size;
  const rotationPct = psPoolCount > 0 ? Math.round(rotatedCount / psPoolCount * 100) : 0;

  // 7. Deployment Deviation
  const nhAll = ftpt.filter(a => a.d >= cutoffStr);
  // Skip deviation for now (needs scan data which is complex)
  const nhDevPct = 0;

  // Build record
  const record = {
    metric_date: today, fetch_time: fetchTime,
    ftpt_rampup_pct: String(ftptPct), ftpt_ramped: String(ftptRamped), ftpt_total: String(ftpt.length),
    ftpt_tenured_pct: String(tenuredPct), ftpt_tenured_ramped: String(tenuredRamped), ftpt_tenured_total: String(tenuredFtpt.length),
    alfa_rampup_pct: String(alfaPct), alfa_ramped: String(alfaRamped), alfa_total: String(tenuredAlfa.length),
    alfa_crit_rampup_pct: String(alfaCritPct), alfa_crit_ramped: String(alfaCritRamped), alfa_crit_total: String(alfaCritCount),
    alfa_crit_pool_pct: String(alfaCritPoolPct),
    cross_training_pct: String(ctPct), cross_trained: String(ctRamped),
    ft_critical: String(ftCrit.length), ft_total: String(ft.length), ft_critical_pct: String(ftCritPct),
    pt_critical: String(ptCrit.length), pt_total: String(pt.length), pt_critical_pct: String(ptCritPct),
    ftpt_critical: String(ftptCrit.length), ftpt_critical_pct: String(ftptCritPct),
    coaching_target: String(coachTarget), coaching_completed: String(coachCompleted), coaching_pending: String(coachPending), coaching_pct: String(coachPct),
    ps_planned: String(PLANNED_HC), ps_actual: String(actualHC), ps_certified: String(certifiedHC), ps_deploy_pct: String(deployPct),
    ps_pool: String(psPoolCount), ps_rotated: String(rotatedCount), ps_rotation_pct: String(rotationPct),
    nh_deviation_pct: String(nhDevPct), nh_count: String(nhAll.length), nh_worked: '0'
  };

  console.log(`  FT+PT Ramp: ${ftptRamped}/${ftpt.length} = ${ftptPct}%`);
  console.log(`  Tenured FT+PT: ${tenuredRamped}/${tenuredFtpt.length} = ${tenuredPct}%`);
  console.log(`  ALFA (Tenured): ${alfaRamped}/${tenuredAlfa.length} = ${alfaPct}%`);
  console.log(`  Cross-Training: ${ctRamped}/${ftpt.length} = ${ctPct}%`);
  console.log(`  PS Deploy (D-1): Cert=${certifiedHC}/Plan=${PLANNED_HC} = ${deployPct}%`);

  // Load existing metrics_data.json or start fresh
  let allData = [];
  if (fs.existsSync('metrics_data.json')) {
    try { allData = JSON.parse(fs.readFileSync('metrics_data.json', 'utf8')); } catch(e) {}
  }

  // Dedup: remove existing entry for today, add new
  allData = allData.filter(d => d.metric_date !== today);
  allData.push(record);
  allData.sort((a, b) => a.metric_date.localeCompare(b.metric_date));

  // Save metrics_data.json
  fs.writeFileSync('metrics_data.json', JSON.stringify(allData, null, 2));
  console.log(`  Saved metrics_data.json (${allData.length} records)`);

  // Generate dashboard HTML from template
  const template = fs.readFileSync('dashboard_template.html', 'utf8');
  const jsonStr = JSON.stringify(allData);
  let html = template.replace('let metricsData = [];', 'let metricsData = ' + jsonStr + ';');
  html = html.replace(/async function loadData\(\)\{[\s\S]*?\n\}/, 'async function loadData(){metricsData.sort((a,b)=>a.metric_date.localeCompare(b.metric_date));renderAll();}');
  fs.writeFileSync('index.html', html);
  console.log(`  Generated index.html`);
  console.log('=== DONE ===');
}

main().catch(e => { console.error(e); process.exit(1); });
