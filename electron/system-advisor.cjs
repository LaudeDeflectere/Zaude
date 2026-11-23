// Local Hardware Analyzer, AI Web-Research Prompt Runner, and 1-Click Local Video Model Installer.
// Inspects GPU (VRAM, compute capability, driver), RAM, free disk storage, and existing ComfyUI/Python
// optimizations; recommends fitting local video models + LoRAs + optimizations; optionally invokes an
// installed AI CLI agent (Codex, Claude, OpenCode) to search the web for the newest models/LoRAs; and
// installs everything (ComfyUI + custom nodes + optimizations + model + LoRAs) in one click.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const aiChat = require('./ai-chat.cjs');

const DEFAULT_COMFY_DIR = path.join(os.homedir(), 'ComfyUI');

// Curated baseline catalog of local video models, LoRAs, and GPU-matched optimizations.
const MODEL_CATALOG = [
  {
    id: 'ltx-video-2b-gguf',
    name: 'LTX-Video 2B (0.9.8 Distilled · GGUF Q4_K_M)',
    family: 'LTX-Video',
    minVramGb: 6,
    minRamGb: 12,
    diskGb: 7.5,
    supportsFl2v: true,
    supportsRefmod: false,
    maxRes: '480p (768×512)',
    estSpeed8gb: '~30–75s / 4s clip',
    summary: 'Best lightweight model for 8 GB laptops. Native First & Last Frame (FrameToFrame) + fast 0.9.8 distilled sampling.',
    loras: [
      { name: 'LTX-Video 0.9.8 Distilled (baked-in 8-step)', repo: 'calcuis/ltxv-gguf', file: 'ltxv-2b-0.9.8-distilled-q4_k_m.gguf', dest: 'models/unet' },
    ],
    downloads: [
      { label: 'LTX-Video 2B 0.9.8 Distilled Q4_K_M GGUF', url: 'https://huggingface.co/calcuis/ltxv-gguf/resolve/main/ltxv-2b-0.9.8-distilled-q4_k_m.gguf', dest: 'models/unet/ltxv-2b-0.9.8-distilled-q4_k_m.gguf' },
      { label: 'LTX-Video VAE (fp16)', url: 'https://huggingface.co/calcuis/ltxv-gguf/resolve/main/ltxv_0.9.5_vae_fp16.safetensors', dest: 'models/vae/ltxv_0.9.5_vae_fp16.safetensors' },
      { label: 'T5-XXL Encoder Q4_K_M GGUF', url: 'https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf/resolve/main/t5-v1_1-xxl-encoder-Q4_K_M.gguf', dest: 'models/clip/t5-v1_1-xxl-encoder-Q4_K_M.gguf' },
    ],
    customNodes: [
      { name: 'ComfyUI-GGUF', repo: 'https://github.com/city96/ComfyUI-GGUF.git' },
      { name: 'ComfyUI-VideoHelperSuite', repo: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git' },
      { name: 'ComfyUI-LTXVideo', repo: 'https://github.com/Lightricks/ComfyUI-LTXVideo.git' },
      { name: 'ComfyUI-TeaCache', repo: 'https://github.com/welltop-cn/ComfyUI-TeaCache.git' },
    ],
  },
  {
    id: 'wan21-1.3b-gguf',
    name: 'Wan 2.1 1.3B T2V / VACE (GGUF Q8_0 + CausVid LoRA)',
    family: 'Wan 2.1',
    minVramGb: 6,
    minRamGb: 12,
    diskGb: 6.5,
    supportsFl2v: true,
    supportsRefmod: false,
    maxRes: '480p (832×480)',
    estSpeed8gb: '~45–95s / 4s clip',
    summary: 'Sharp lightweight 1.3B video generator + VACE stylize/inpaint support with 4–8 step CausVid/LightX2V turbo LoRAs.',
    loras: [
      { name: 'Wan 2.1 CausVid 4–8 Step Turbo LoRA', url: 'https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Wan21_CausVid_bidirect2_T2V_1_3B_lora_rank32.safetensors', dest: 'models/loras/Wan21_CausVid_T2V_1_3B_lora_rank32.safetensors' },
    ],
    downloads: [
      { label: 'Wan 2.1 1.3B T2V Q8_0 GGUF', url: 'https://huggingface.co/calcuis/wan-gguf/resolve/main/wan2.1_t2v_1.3b-q8_0.gguf', dest: 'models/unet/wan2.1_t2v_1.3b-q8_0.gguf' },
      { label: 'Wan 2.1 Video VAE (fp16)', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', dest: 'models/vae/wan_2.1_vae.safetensors' },
      { label: 'UMT5-XXL Encoder Q4_K_M GGUF', url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q4_K_M.gguf', dest: 'models/clip/umt5-xxl-encoder-Q4_K_M.gguf' },
    ],
    customNodes: [
      { name: 'ComfyUI-GGUF', repo: 'https://github.com/city96/ComfyUI-GGUF.git' },
      { name: 'ComfyUI-VideoHelperSuite', repo: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git' },
      { name: 'ComfyUI-TeaCache', repo: 'https://github.com/welltop-cn/ComfyUI-TeaCache.git' },
      { name: 'ComfyUI-WanVideoWrapper', repo: 'https://github.com/kijai/ComfyUI-WanVideoWrapper.git' },
    ],
  },
  {
    id: 'wan21-14b-flf2v-gguf',
    name: 'Wan 2.1 14B FLF2V (GGUF Q4_K_S + LightX2V 4-Step LoRA)',
    family: 'Wan 2.1 14B',
    minVramGb: 12,
    minRamGb: 24,
    diskGb: 18.0,
    supportsFl2v: true,
    supportsRefmod: false,
    maxRes: '720p (1280×720)',
    estSpeed8gb: 'Needs ≥12 GB VRAM',
    summary: 'High-quality dedicated First & Last Frame 14B model with LightX2V 4-step acceleration LoRA.',
    loras: [
      { name: 'LightX2V 4-Step Turbo LoRA', url: 'https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', dest: 'models/loras/lightx2v_I2V_14B_480p_rank64_bf16.safetensors' },
    ],
    downloads: [
      { label: 'Wan 2.1 14B FLF2V Q4_K_S GGUF', url: 'https://huggingface.co/city96/Wan2.1-FLF2V-14B-720P-gguf/resolve/main/wan2.1-flf2v-14b-720p-Q4_K_S.gguf', dest: 'models/unet/wan2.1-flf2v-14b-720p-Q4_K_S.gguf' },
      { label: 'Wan 2.1 Video VAE (fp16)', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', dest: 'models/vae/wan_2.1_vae.safetensors' },
      { label: 'UMT5-XXL Encoder Q4_K_M GGUF', url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q4_K_M.gguf', dest: 'models/clip/umt5-xxl-encoder-Q4_K_M.gguf' },
    ],
    customNodes: [
      { name: 'ComfyUI-GGUF', repo: 'https://github.com/city96/ComfyUI-GGUF.git' },
      { name: 'ComfyUI-VideoHelperSuite', repo: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git' },
      { name: 'ComfyUI-TeaCache', repo: 'https://github.com/welltop-cn/ComfyUI-TeaCache.git' },
      { name: 'ComfyUI-WanVideoWrapper', repo: 'https://github.com/kijai/ComfyUI-WanVideoWrapper.git' },
    ],
  },
  {
    id: 'minimax-h3-refmod',
    name: 'MiniMax-H3 (Ref2VA + FL2VA int8 + 4/8-Step Turbo LoRAs)',
    family: 'MiniMax-H3',
    minVramGb: 24,
    minRamGb: 32,
    diskGb: 38.0,
    supportsFl2v: true,
    supportsRefmod: true,
    maxRes: '720p (1280×704)',
    estSpeed8gb: 'Requires ≥24 GB VRAM (RTX 3090/4090)',
    summary: 'Full RefMod character identity + synced audio + First/Last Frame. Use on your RTX 3090 machine.',
    loras: [],
    downloads: [],
    customNodes: [],
  },
];

// System prompt engineered for the live AI web-research agent to find the newest & greatest local video models.
const WEB_RESEARCH_SYSTEM_PROMPT = `You are Zaude's Local AI Video Hardware & Model Researcher.
Your job is to search the web (HuggingFace, GitHub, ComfyUI ecosystem) for the NEWEST and GREATEST open-source local AI video generation models, quantized checkpoints (GGUF / FP8 / int8), turbo/distilled LoRAs (CausVid, LightX2V, Self-Forcing, DMD, Hyper), and ComfyUI inference optimizations (SageAttention, FlashAttention, xFormers, TeaCache, TorchCompile, GGUF) that actually fit the user's exact hardware.

Rules:
1. Respect the user's EXACT VRAM, System RAM, GPU compute capability (e.g. Turing sm_75 cannot use native FP8/BF16 tensor cores; Ampere sm_80+ can), and free disk space. Never recommend a model that will OOM.
2. Always note whether each model supports First & Last Frame (FLF2V / FrameToFrame), Image-to-Video, and Character/LoRA consistency.
3. For each top recommendation, list:
   - Exact Model Name & Quantization (e.g. Q4_K_M GGUF, FP8)
   - Best Turbo/Speed LoRAs available right now
   - Best ComfyUI Optimizations for their exact GPU architecture
   - Approximate VRAM, RAM, Disk size, and expected render speed
   - Direct HuggingFace or GitHub repo link
4. Keep the response crisp, structured in markdown, and actionable.`;

function safeRun(cmd, args, timeoutMs = 4000) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (r.status === 0) return String(r.stdout || '').trim();
  } catch { /* ignore */ }
  return '';
}

function getDiskFreeGb(targetDir) {
  try {
    const dir = fs.existsSync(targetDir) ? targetDir : os.homedir();
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(dir);
      const freeGb = (Number(st.bavail) * Number(st.bsize)) / (1024 ** 3);
      const totalGb = (Number(st.blocks) * Number(st.bsize)) / (1024 ** 3);
      return { freeGb: Math.round(freeGb * 10) / 10, totalGb: Math.round(totalGb * 10) / 10 };
    }
  } catch { /* ignore */ }
  return { freeGb: 0, totalGb: 0 };
}

function analyzeSystem({ comfyDir = DEFAULT_COMFY_DIR } = {}) {
  const cpus = os.cpus() || [];
  const ramTotalGb = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
  const ramFreeGb = Math.round((os.freemem() / (1024 ** 3)) * 10) / 10;
  const disk = getDiskFreeGb(comfyDir);

  let gpu = {
    vendor: 'unknown',
    name: 'No dedicated NVIDIA GPU detected',
    vramTotalGb: 0,
    vramFreeGb: 0,
    computeCap: 0,
    driver: '',
    archNote: 'CPU / Integrated GPU only',
  };

  const smi = safeRun('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.free,driver_version,compute_cap',
    '--format=csv,noheader,nounits',
  ]);
  if (smi) {
    const first = smi.split(/\r?\n/)[0].split(',').map((s) => s.trim());
    const vramTotalGb = Math.round(((Number(first[1]) || 0) / 1024) * 10) / 10;
    const vramFreeGb = Math.round(((Number(first[2]) || 0) / 1024) * 10) / 10;
    const computeCap = Number(first[4]) || 0;
    let archNote = 'CUDA GPU';
    if (computeCap >= 8.9) archNote = 'Ada/Blackwell (native FP8 + BF16 + SageAttention)';
    else if (computeCap >= 8.0) archNote = 'Ampere (native BF16 + FlashAttn2 + SageAttention)';
    else if (computeCap >= 7.5) archNote = 'Turing (FP16 Tensor Cores · use GGUF Q4 + xFormers/SDPA, no native BF16/FP8)';
    else if (computeCap > 0) archNote = `Compute ${computeCap} (FP16/FP32)`;
    gpu = {
      vendor: 'nvidia',
      name: first[0] || 'NVIDIA GPU',
      vramTotalGb,
      vramFreeGb,
      computeCap,
      driver: first[3] || '',
      archNote,
    };
  }

  const tools = {
    python: Boolean(safeRun('python3', ['--version'])),
    git: Boolean(safeRun('git', ['--version'])),
    curl: Boolean(safeRun('curl', ['--version'])),
    ffmpeg: Boolean(safeRun('ffmpeg', ['-version'])),
    comfyInstalled: fs.existsSync(path.join(comfyDir, 'main.py')),
    comfyDir,
  };

  const optimizations = computeOptimizations(gpu);
  const recommendations = recommendModels({ gpu, ramTotalGb, diskFreeGb: disk.freeGb, optimizations });

  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    cpu: { model: cpus[0] ? cpus[0].model : 'Unknown CPU', cores: cpus.length },
    ram: { totalGb: ramTotalGb, freeGb: ramFreeGb },
    disk,
    gpu,
    tools,
    optimizations,
    recommendations,
    checkedAt: new Date().toISOString(),
  };
}

function computeOptimizations(gpu) {
  const cap = Number(gpu && gpu.computeCap) || 0;
  const vram = Number(gpu && gpu.vramTotalGb) || 0;
  const pkgs = [];
  const flags = [];
  if (cap >= 8.0) {
    pkgs.push('sageattention', 'triton');
    flags.push('--use-sage-attention');
  } else if (cap >= 7.5) {
    pkgs.push('xformers');
    flags.push('--use-pytorch-cross-attention', '--force-fp16');
  }
  if (vram > 0 && vram <= 10) {
    flags.push('--lowvram');
  } else if (vram > 10 && vram <= 16) {
    flags.push('--normalvram');
  }
  flags.push('--preview-method', 'auto');
  return {
    pipPackages: pkgs,
    comfyFlags: flags,
    nodes: ['ComfyUI-GGUF', 'ComfyUI-TeaCache', 'ComfyUI-VideoHelperSuite'],
  };
}

function recommendModels({ gpu, ramTotalGb, diskFreeGb, optimizations }) {
  const vram = Number(gpu && gpu.vramTotalGb) || 0;
  return MODEL_CATALOG.map((m) => {
    const vramOk = vram >= m.minVramGb - 0.5;
    const ramOk = ramTotalGb >= m.minRamGb - 1;
    const diskOk = diskFreeGb >= m.diskGb + 2;
    const fits = vramOk && ramOk && diskOk;
    const blockers = [];
    if (!vramOk) blockers.push(`Needs ${m.minVramGb} GB VRAM (have ${vram} GB)`);
    if (!ramOk) blockers.push(`Needs ${m.minRamGb} GB RAM (have ${ramTotalGb} GB)`);
    if (!diskOk) blockers.push(`Needs ${m.diskGb} GB free disk (have ${diskFreeGb} GB)`);

    let badge = 'Compatible';
    if (!fits) badge = 'Too Heavy';
    else if (vram <= 10 && m.id === 'ltx-video-2b-gguf') badge = 'Best Fit (8 GB Laptop)';
    else if (vram <= 10 && m.id === 'wan21-1.3b-gguf') badge = 'Great Fit (8 GB Laptop)';
    else if (vram >= 22 && m.id === 'minimax-h3-refmod') badge = 'Best Fit (24 GB+)';
    else if (vram >= 12 && m.id === 'wan21-14b-flf2v-gguf') badge = 'Best Fit (12–16 GB)';

    return {
      ...m,
      fits,
      badge,
      blockers,
      optimizations,
    };
  });
}

function buildResearchPrompt(report) {
  return [
    WEB_RESEARCH_SYSTEM_PROMPT,
    '',
    '### User Hardware Profile (measured live)',
    `- GPU: ${report.gpu.name} (${report.gpu.vramTotalGb} GB VRAM total, ${report.gpu.vramFreeGb} GB free, compute ${report.gpu.computeCap}, ${report.gpu.archNote})`,
    `- CPU: ${report.cpu.model} (${report.cpu.cores} threads)`,
    `- System RAM: ${report.ram.totalGb} GB total (${report.ram.freeGb} GB free)`,
    `- Free Disk Space: ${report.disk.freeGb} GB free of ${report.disk.totalGb} GB`,
    `- OS: ${report.platform} (${report.arch})`,
    '',
    'Search the web right now for the NEWEST and GREATEST open-source local AI video models (GGUF/FP8/distilled), best turbo LoRAs, and ComfyUI optimizations that fit this exact GPU. Include First & Last Frame capability and direct HuggingFace/GitHub links.',
  ].join('\n');
}

// Uses an installed AI CLI agent (Codex / Claude / OpenCode) with web access to scrape/check newest models.
function runWebResearch({ provider = 'auto', report, onChunk = () => {} }) {
  const providers = aiChat.detectProviders();
  let chosen = provider;
  if (!chosen || chosen === 'auto') {
    const order = ['codex', 'claude', 'opencode'];
    chosen = order.find((p) => providers[p] && providers[p].available) || 'codex';
  }
  const prompt = buildResearchPrompt(report);
  const built = aiChat.buildCliCommand(chosen, { prompt, mcpConfigPath: null, cwd: os.homedir() });
  if (!built.ok) {
    return { promise: Promise.resolve({ ok: false, error: built.error }), cancel: () => {} };
  }

  let child;
  try {
    child = spawn(built.bin, built.args, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    return { promise: Promise.resolve({ ok: false, error: e.message }), cancel: () => {} };
  }

  let fullOut = '';
  let errOut = '';
  let cancelled = false;
  child.stdout.on('data', (c) => {
    const t = String(c);
    fullOut += t;
    onChunk({ type: 'chunk', text: t, provider: chosen });
  });
  child.stderr.on('data', (c) => { errOut += String(c); });

  const promise = new Promise((resolve) => {
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (cancelled) return resolve({ ok: false, cancelled: true, error: 'Cancelled' });
      if (code === 0 && fullOut.trim()) return resolve({ ok: true, provider: chosen, text: fullOut.trim() });
      resolve({ ok: false, provider: chosen, error: errOut.trim() || fullOut.trim() || `${chosen} exited with code ${code}` });
    });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    },
  };
}

// 1-Click Installer: installs ComfyUI (if needed), custom nodes, GPU optimizations, model weights, and LoRAs.
function installModel({ modelId, comfyDir = DEFAULT_COMFY_DIR, gpu = null, onLog = () => {} }) {
  const model = MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model) {
    return { promise: Promise.resolve({ ok: false, error: `Unknown model "${modelId}"` }), cancel: () => {} };
  }
  if (!model.downloads.length && !model.loras.length) {
    return {
      promise: Promise.resolve({ ok: false, error: `${model.name} is managed via your remote RTX 3090 Mannimmate setup.` }),
      cancel: () => {},
    };
  }

  const disk = getDiskFreeGb(comfyDir);
  if (disk.freeGb > 0 && disk.freeGb < model.diskGb + 1) {
    return {
      promise: Promise.resolve({ ok: false, error: `Not enough free disk space: need ~${model.diskGb} GB, only ${disk.freeGb} GB free.` }),
      cancel: () => {},
    };
  }

  let cancelled = false;
  let currentChild = null;

  const execStep = (label, bin, args, cwd) => new Promise((resolve, reject) => {
    if (cancelled) return reject(new Error('Cancelled'));
    onLog({ type: 'step', text: `▶ ${label}` });
    const child = spawn(bin, args, { cwd, windowsHide: true });
    currentChild = child;
    child.stdout.on('data', (c) => onLog({ type: 'log', text: String(c).trim() }));
    child.stderr.on('data', (c) => {
      const s = String(c).trim();
      if (s) onLog({ type: 'log', text: s });
    });
    child.on('error', reject);
    child.on('close', (code) => {
      currentChild = null;
      if (cancelled) return reject(new Error('Cancelled'));
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (exit ${code})`));
    });
  });

  const promise = (async () => {
    try {
      const opts = computeOptimizations(gpu || {});
      // 1. Ensure ComfyUI exists
      if (!fs.existsSync(path.join(comfyDir, 'main.py'))) {
        await execStep(`Cloning ComfyUI into ${comfyDir}`, 'git', ['clone', '--depth', '1', 'https://github.com/comfyanonymous/ComfyUI.git', comfyDir], os.homedir());
      } else {
        onLog({ type: 'log', text: `ComfyUI already installed at ${comfyDir}` });
      }

      // 2. Ensure Python venv + PyTorch CUDA + requirements
      const venvDir = path.join(comfyDir, '.venv');
      const venvPy = path.join(venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const pipArgs = (...rest) => ['-m', 'pip', ...rest];
      if (!fs.existsSync(venvPy)) {
        await execStep('Creating Python venv for ComfyUI', 'python3', ['-m', 'venv', venvDir], comfyDir);
        await execStep('Installing PyTorch CUDA + ComfyUI requirements', venvPy, pipArgs('install', '--upgrade', 'pip', 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu124'), comfyDir);
        await execStep('Installing ComfyUI dependencies', venvPy, pipArgs('install', '-r', 'requirements.txt'), comfyDir);
      }

      // 3. Install GPU-matched optimization packages (use --no-deps for xformers so we never downgrade PyTorch CUDA)
      if (opts.pipPackages.length) {
        const extraFlags = opts.pipPackages.includes('xformers') ? ['--no-deps'] : [];
        await execStep(`Installing GPU optimizations (${opts.pipPackages.join(', ')})`, venvPy, pipArgs('install', ...extraFlags, ...opts.pipPackages), comfyDir).catch((e) => {
          onLog({ type: 'log', text: `Warning: optional optimization install skipped (${e.message})` });
        });
      }

      // 4. Clone custom nodes (GGUF, TeaCache, VideoHelperSuite, model wrapper) and ensure requirements are installed
      const nodesRoot = path.join(comfyDir, 'custom_nodes');
      fs.mkdirSync(nodesRoot, { recursive: true });
      for (const node of (model.customNodes || [])) {
        const dest = path.join(nodesRoot, node.name);
        if (!fs.existsSync(dest)) {
          await execStep(`Installing node ${node.name}`, 'git', ['clone', '--depth', '1', node.repo, dest], nodesRoot);
        } else {
          onLog({ type: 'log', text: `Node ${node.name} already installed` });
        }
        const reqTxt = path.join(dest, 'requirements.txt');
        if (fs.existsSync(reqTxt)) {
          await execStep(`Ensuring ${node.name} requirements`, venvPy, pipArgs('install', '-r', reqTxt), dest).catch((e) => {
            onLog({ type: 'log', text: `Warning: ${node.name} requirements warning (${e.message})` });
          });
        }
      }

      // 5. Download model weights, text encoder, VAE, and Turbo LoRAs (with resume support)
      const allFiles = [
        ...(model.downloads || []),
        ...(model.loras || []).filter((l) => l.url).map((l) => ({ label: l.name, url: l.url, dest: l.dest })),
      ];
      for (const item of allFiles) {
        const absDest = path.join(comfyDir, item.dest);
        fs.mkdirSync(path.dirname(absDest), { recursive: true });
        await execStep(`Downloading ${item.label}`, 'curl', ['-L', '-C', '-', '--fail', '--progress-bar', '-o', absDest, item.url], comfyDir);
      }

      const launchCmd = `${venvPy} ${path.join(comfyDir, 'main.py')} ${opts.comfyFlags.join(' ')}`.trim();
      onLog({ type: 'done', text: `Installed ${model.name}! Launch ComfyUI with: ${launchCmd}` });
      return { ok: true, comfyDir, launchCmd };
    } catch (err) {
      if (cancelled) return { ok: false, cancelled: true, error: 'Install cancelled' };
      return { ok: false, error: err.message || String(err) };
    }
  })();

  return {
    promise,
    cancel() {
      cancelled = true;
      try { if (currentChild) currentChild.kill('SIGTERM'); } catch { /* ignore */ }
    },
  };
}

module.exports = {
  MODEL_CATALOG,
  WEB_RESEARCH_SYSTEM_PROMPT,
  analyzeSystem,
  computeOptimizations,
  recommendModels,
  buildResearchPrompt,
  runWebResearch,
  installModel,
};
