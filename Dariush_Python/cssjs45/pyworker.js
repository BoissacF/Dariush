//self.importScripts("https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js");
// Pyodide en local  : même chemin relatif en ligne ET en portable

// Source de Pyodide selon le mode (drapeau transmis via l'URL du worker) :
//  - en ligne (VPS) : CDN  -> bibliotheque complete (folium, scipy, etc.)
//  - en portable    : local -> coeur + matplotlib hors-ligne
const __pyParams   = new URLSearchParams(self.location.search);
const __pyPortable = __pyParams.get("portable") === "1";
const PYODIDE_CDN   = "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/";
const PYODIDE_LOCAL = new URL(
  "../../Dariush_Commun/fichiersannexes/pyodide/",
  self.location.href
).href;
const PYODIDE_BASE = __pyPortable ? PYODIDE_LOCAL : PYODIDE_CDN;
self.importScripts(PYODIDE_BASE + "pyodide.js");



let pyodide = null;
let isReady = false;

let autopep8Ready = false;
let autopep8LoadingPromise = null;



let inputRequestId = 0;
const pendingInputResolvers = new Map();

async function buildDebugSnapshotsInWorker(code, contextCode = "", activePageIndex = 0) {
  if (!pyodide || !isReady) {
    
    throw new Error("Pyodide non prêt dans le worker.");
  }
  
  await resetPythonState();

  const userCode = normalizeLeadingTabs(code);
  const previousCode = normalizeLeadingTabs(contextCode);

  // Index reel de la page active dans le notebook. Sert a tagger chaque
  // snapshot avec sa page, pour que le debogueur sache sur quelle page se
  // trouve la ligne courante (et puisse y basculer lors d'un step into).
  let activeIndex = parseInt(activePageIndex, 10);
  if (!Number.isFinite(activeIndex) || activeIndex < 0) {
    activeIndex = 0;
  }

  await installDariushRuntime();
  await ensurePackagesForCode(previousCode + "\n" + userCode);
   // Marqueur : a partir d'ici, le thread principal arme un chien de garde
  // (le rejeu du contexte + le trace ne doivent pas tourner indefiniment).
  post("debug_replay_start");
  pyodide.globals.set("__DEBUG_USER_CODE__", userCode);
  pyodide.globals.set("__DEBUG_CONTEXT_CODE__", previousCode);
  pyodide.globals.set("__DEBUG_ACTIVE_PAGE_INDEX__", activeIndex);

  try {
    const raw = await pyodide.runPythonAsync(`
import sys
import json
import traceback
import io

USER_CODE = __DEBUG_USER_CODE__
CONTEXT_CODE = __DEBUG_CONTEXT_CODE__
ACTIVE_PAGE_INDEX = __DEBUG_ACTIVE_PAGE_INDEX__

snapshots = []
step_counter = 0
context_globals_snapshot = {}
context_error = None
MAX_STEPS = 5000

# Associe chaque nom de fichier <dariush_page_N> a son index de page reel.
# Le tracer ne suit/enregistre que les frames dont le fichier est dans ce dict.
page_of_filename = {}

def safe_repr(value, max_len=120):
    try:
        r = repr(value)
    except Exception:
        r = "<repr impossible>"
    if len(r) > max_len:
        r = r[:max_len] + "…"
    return r

MAX_DEBUG_DEPTH = 4
MAX_DEBUG_ITEMS = 20

def serialize_debug_value(value, depth=0):
    if depth >= MAX_DEBUG_DEPTH:
        return {
            "kind": "simple",
            "python_type": type(value).__name__,
            "value": safe_repr(value)
        }

    if value is None or isinstance(value, (bool, int, float, str)):
        return {
            "kind": "simple",
            "python_type": type(value).__name__,
            "value": safe_repr(value)
        }

    if isinstance(value, list):
        items = []
        limit = min(len(value), MAX_DEBUG_ITEMS)
        for i in range(limit):
            items.append(serialize_debug_value(value[i], depth + 1))
        if len(value) > MAX_DEBUG_ITEMS:
            items.append({
                "kind": "simple",
                "python_type": "truncated",
                "value": f"... {len(value) - MAX_DEBUG_ITEMS} élément(s) supplémentaire(s)"
            })
        return {
            "kind": "list",
            "python_type": "list",
            "size": len(value),
            "items": items
        }

    if isinstance(value, tuple):
        items = []
        limit = min(len(value), MAX_DEBUG_ITEMS)
        for i in range(limit):
            items.append(serialize_debug_value(value[i], depth + 1))
        if len(value) > MAX_DEBUG_ITEMS:
            items.append({
                "kind": "simple",
                "python_type": "truncated",
                "value": f"... {len(value) - MAX_DEBUG_ITEMS} élément(s) supplémentaire(s)"
            })
        return {
            "kind": "tuple",
            "python_type": "tuple",
            "size": len(value),
            "items": items
        }

    if isinstance(value, dict):
        items = {}
        entries = list(value.items())
        limit = min(len(entries), MAX_DEBUG_ITEMS)
        for i in range(limit):
            k, v = entries[i]
            items[safe_repr(k)] = serialize_debug_value(v, depth + 1)
        if len(entries) > MAX_DEBUG_ITEMS:
            items["..."] = {
                "kind": "simple",
                "python_type": "truncated",
                "value": f"{len(entries) - MAX_DEBUG_ITEMS} entrée(s) supplémentaire(s)"
            }
        return {
            "kind": "dict",
            "python_type": "dict",
            "size": len(value),
            "items": items
        }

    if hasattr(value, "__dict__"):
        try:
            attrs = {}
            attr_items = list(value.__dict__.items())
            kept_count = 0

            for attr, val in attr_items:
                if kept_count >= MAX_DEBUG_ITEMS:
                    break
                if attr.startswith("__"):
                    continue
                if callable(val):
                    continue
                attrs[str(attr)] = serialize_debug_value(val, depth + 1)
                kept_count += 1

            remaining = 0
            for attr, val in attr_items:
                if attr.startswith("__"):
                    continue
                if callable(val):
                    continue
                remaining += 1

            if remaining > MAX_DEBUG_ITEMS:
                attrs["..."] = {
                    "kind": "simple",
                    "python_type": "truncated",
                    "value": f"{remaining - MAX_DEBUG_ITEMS} attribut(s) supplémentaire(s)"
                }

            return {
                "kind": "object",
                "python_type": type(value).__name__,
                "attributes": attrs
            }
        except Exception:
            return {
                "kind": "simple",
                "python_type": type(value).__name__,
                "value": safe_repr(value)
            }

    return {
        "kind": "simple",
        "python_type": type(value).__name__,
        "value": safe_repr(value)
    }

def clean_dict(d, excluded_names=None):
    if excluded_names is None:
        excluded_names = set()

    result = {}
    for k, v in d.items():
        if k in excluded_names:
            continue
        if k.startswith("__") and k.endswith("__"):
            continue
        if callable(v):
            continue

        try:
            type_name = type(v).__name__
        except Exception:
            type_name = ""

        if type_name == "type":
            continue

        result[str(k)] = serialize_debug_value(v)

    return result

def split_page_globals(all_globals, context_globals):
    result = {}
    for k, v in all_globals.items():
        if k not in context_globals:
            result[k] = v
    return result

class StepStdout(io.StringIO):
    def __init__(self):
        super().__init__()
        self._all_output = ""

    def write(self, s):
        text = str(s)
        self._all_output += text
        return len(text)

    def get_all_output(self):
        return self._all_output

excluded = {
    "sys", "json", "traceback", "io",
    "USER_CODE", "CONTEXT_CODE", "ACTIVE_PAGE_INDEX",
    "snapshots", "step_counter", "context_globals_snapshot", "context_error",
    "page_of_filename", "active_filename",
    "safe_repr", "serialize_debug_value", "clean_dict", "split_page_globals", "StepStdout", "tracer",
    "compiled", "compiled_context", "user_globals",
    "_old_stdout", "_old_stderr", "_fake_stdout", "_fake_stderr",
    "_context_stdout", "_context_stderr",
    "excluded", "all_globals", "page_globals",
    "MAX_DEBUG_DEPTH", "MAX_DEBUG_ITEMS",
    "MAX_STACK_DEPTH", "build_call_stack", "frame_had_error"
}

MAX_STACK_DEPTH = 12

# Frames dont la derniere chose arrivee est une erreur : leur "return" est une
# sortie provoquee par l'erreur qui remonte, pas un vrai resultat.
frame_had_error = {}

def build_call_stack(frame):
    # Pile des APPELANTS de la frame courante, du plus proche au plus lointain,
    # et profondeur d'appel reelle (meme au-dela de MAX_STACK_DEPTH).
    # La frame courante n'est pas incluse : ses variables sont deja dans le
    # snapshot. On remonte f_back tant qu'on reste dans le code de l'eleve
    # (une page connue) et on s'arrete des qu'on en sort.
    stack = []
    depth = 0
    f = frame.f_back
    while f is not None:
        page = page_of_filename.get(f.f_code.co_filename)
        if page is None:
            break
        depth += 1
        if len(stack) < MAX_STACK_DEPTH:
            f_same_scope = (f.f_code.co_name == "<module>") or (f.f_locals is f.f_globals)
            stack.append({
                "function": f.f_code.co_name,
                "line": f.f_lineno,
                "page": page,
                "same_scope": f_same_scope,
                "locals": {} if f_same_scope else clean_dict(f.f_locals, excluded)
            })
        f = f.f_back
    return stack, depth

def tracer(frame, event, arg):
    global step_counter

    # On ne trace QUE les pages connues (page active + pages precedentes
    # taguees). current_page = l'index reel de la page de la ligne courante.
    current_page = page_of_filename.get(frame.f_code.co_filename)
    if current_page is None:
        return tracer

    if step_counter >= MAX_STEPS:
        return None

    same_scope = (frame.f_code.co_name == "<module>") or (frame.f_locals is frame.f_globals)

    if event == "line":
        step_counter += 1
        frame_had_error.pop(id(frame), None)
        all_globals = clean_dict(frame.f_globals, excluded)
        page_globals = split_page_globals(all_globals, context_globals_snapshot)
        call_stack, call_depth = build_call_stack(frame)

        snapshots.append({
            "step": step_counter,
            "event": "line",
            "depth": call_depth,
            "line": frame.f_lineno,
            "function": frame.f_code.co_name,
            "page": current_page,
            "same_scope": same_scope,
            "locals": {} if same_scope else clean_dict(frame.f_locals, excluded),
            "stack": call_stack,
            "globals": page_globals,
            "context_globals": context_globals_snapshot,
            "context_error": context_error,
            "stdout": _fake_stdout.get_all_output()
        })

    elif event == "exception":
        exc_type, exc_value, exc_tb = arg
        frame_had_error[id(frame)] = True
        all_globals = clean_dict(frame.f_globals, excluded)
        page_globals = split_page_globals(all_globals, context_globals_snapshot)
        call_stack, call_depth = build_call_stack(frame)

        snapshots.append({
            "step": step_counter + 1,
            "event": "exception",
            "depth": call_depth,
            "line": frame.f_lineno,
            "function": frame.f_code.co_name,
            "page": current_page,
            "same_scope": same_scope,
            "error_type": getattr(exc_type, "__name__", "Exception"),
            "error_message": str(exc_value),
            "locals": {} if same_scope else clean_dict(frame.f_locals, excluded),
            "stack": call_stack,
            "globals": page_globals,
            "context_globals": context_globals_snapshot,
            "context_error": context_error,
            "stdout": _fake_stdout.get_all_output()
        })

    elif event == "return":
        # Sortie d'une fonction : une etape de plus, qui montre CE QUE la
        # fonction renvoie. Le programme principal ne renvoie rien, et une
        # sortie provoquee par une erreur qui remonte n'est pas un resultat :
        # ces deux cas ne donnent pas d'etape.
        had_error = frame_had_error.pop(id(frame), False)

        if (not same_scope) and (not had_error):
            all_globals = clean_dict(frame.f_globals, excluded)
            page_globals = split_page_globals(all_globals, context_globals_snapshot)
            call_stack, call_depth = build_call_stack(frame)

            snapshots.append({
                "step": step_counter,
                "event": "return",
                "depth": call_depth,
                "line": frame.f_lineno,
                "function": frame.f_code.co_name,
                "page": current_page,
                "same_scope": same_scope,
                "locals": clean_dict(frame.f_locals, excluded),
                "stack": call_stack,
                "globals": page_globals,
                "context_globals": context_globals_snapshot,
                "context_error": context_error,
                "return_value": serialize_debug_value(arg),
                "stdout": _fake_stdout.get_all_output()
            })

    return tracer

_old_stdout = sys.stdout
_old_stderr = sys.stderr
_fake_stdout = StepStdout()
_fake_stderr = io.StringIO()
_context_stdout = io.StringIO()
_context_stderr = io.StringIO()

try:
    try:
        active_filename = "<dariush_page_" + str(ACTIVE_PAGE_INDEX) + ">"
        compiled = compile(USER_CODE, active_filename, "exec")
        page_of_filename[active_filename] = ACTIVE_PAGE_INDEX
    except Exception as e:
        snapshots.append({
            "step": 1,
            "event": "syntax_error",
            "line": getattr(e, "lineno", None),
            "function": "<module>",
            "page": ACTIVE_PAGE_INDEX,
            "same_scope": True,
            "error_type": e.__class__.__name__,
            "error_message": str(e),
            "traceback": traceback.format_exc(),
            "locals": {},
            "globals": {},
            "context_globals": {},
            "context_error": None,
            "stdout": ""
        })
        compiled = None
    else:
        user_globals = dict(__dariush_globals__)

        sys.stdout = _fake_stdout
        sys.stderr = _fake_stderr

        if CONTEXT_CODE.strip():
            page_sep = "\\n###__DARIUSH_PAGE_SEP__###\\n"
            if page_sep in CONTEXT_CODE:
                pages_codes = CONTEXT_CODE.split(page_sep)
            else:
                pages_codes = [CONTEXT_CODE]

            any_page_failed = False
            first_error = None

            # Chaque page precedente est compilee avec un nom de fichier unique
            # <dariush_page_N> (N = son index reel) et executee en silencieux
            # AVANT settrace : ses lignes top-level ne sont jamais enregistrees,
            # mais les fonctions qu'elle definit portent ce nom de fichier, ce
            # qui permet d'y ENTRER (step into) depuis une autre page.
            for page_index, page_code in enumerate(pages_codes):
                if not page_code.strip():
                    continue
                page_filename = "<dariush_page_" + str(page_index) + ">"
                try:
                    compiled_context = compile(page_code, page_filename, "exec")
                    page_of_filename[page_filename] = page_index
                    sys.stdout = _context_stdout
                    sys.stderr = _context_stderr
                    try:
                        exec(compiled_context, user_globals, user_globals)
                    finally:
                        sys.stdout = _fake_stdout
                        sys.stderr = _fake_stderr
                except Exception as e:
                    sys.stdout = _fake_stdout
                    sys.stderr = _fake_stderr
                    any_page_failed = True
                    if first_error is None:
                        first_error = {
                            "error_type": e.__class__.__name__,
                            "error_message": str(e),
                            "traceback": traceback.format_exc()
                        }

            context_globals_snapshot = clean_dict(user_globals, excluded)

            if any_page_failed:
                context_error = first_error

        if compiled is not None:
            sys.settrace(tracer)
            try:
                exec(compiled, user_globals, user_globals)
            finally:
                sys.settrace(None)

            all_globals = clean_dict(user_globals, excluded)
            page_globals = split_page_globals(all_globals, context_globals_snapshot)

            snapshots.append({
                "step": step_counter + 1,
                "event": "end",
                "line": snapshots[-1]["line"] if snapshots else None,
                "function": "<module>",
                "page": ACTIVE_PAGE_INDEX,
                "same_scope": True,
                "locals": {},
                "globals": page_globals,
                "context_globals": context_globals_snapshot,
                "context_error": context_error,
                "stdout": _fake_stdout.get_all_output()
            })

except Exception as e:
    snapshots.append({
        "step": step_counter + 1,
        "event": "fatal_exception",
        "line": getattr(e, "lineno", None),
        "function": "<module>",
        "page": ACTIVE_PAGE_INDEX,
        "same_scope": True,
        "error_type": e.__class__.__name__,
        "error_message": str(e),
        "traceback": traceback.format_exc(),
        "locals": {},
        "globals": {},
        "context_globals": {},
        "context_error": context_error,
        "stdout": _fake_stdout.get_all_output()
    })
finally:
    sys.stdout = _old_stdout
    sys.stderr = _old_stderr

json.dumps(snapshots)
`);

    return JSON.parse(raw);
  } finally {
    try {
      pyodide.globals.delete("__DEBUG_USER_CODE__");
      pyodide.globals.delete("__DEBUG_CONTEXT_CODE__");
      pyodide.globals.delete("__DEBUG_ACTIVE_PAGE_INDEX__");
    } catch (err) {
      // rien
    }
  }
}

async function ensureAutopep8ReadyInWorker() {
  if (!pyodide) {
    throw new Error("Pyodide non initialisé");
  }

  if (autopep8Ready) {
    return true;
  }

  if (autopep8LoadingPromise) {
    return autopep8LoadingPromise;
  }

  autopep8LoadingPromise = (async () => {
    try {
      await pyodide.loadPackage("micropip");

      await pyodide.runPythonAsync(`
import importlib.util
import micropip

if importlib.util.find_spec("autopep8") is None:
    await micropip.install("autopep8")
`);

      autopep8Ready = true;
      return true;
    } catch (err) {
      autopep8Ready = false;
      throw err;
    } finally {
      autopep8LoadingPromise = null;
    }
  })();

  return autopep8LoadingPromise;
}



async function runAutopep8InWorker(code) {
  if (!pyodide || !isReady) {
    throw new Error("Pyodide non prêt dans le worker.");
  }

  await ensureAutopep8ReadyInWorker();

  const inputCode = String(code ?? "");
  pyodide.globals.set("__AUTOPEP8_INPUT_CODE__", inputCode);

  try {
    const result = await pyodide.runPythonAsync(`
import autopep8

_code = __AUTOPEP8_INPUT_CODE__
autopep8.fix_code(_code)
`);
    return String(result ?? "");
  } finally {
    try {
      pyodide.globals.delete("__AUTOPEP8_INPUT_CODE__");
    } catch (err) {
      // rien
    }
  }
}

/*
async function runAutopep8InWorker(code) {
  if (!pyodide || !isReady) {
    throw new Error("Pyodide non prêt dans le worker.");
  }

  await ensureAutopep8ReadyInWorker();

  const inputCode = String(code ?? "");
  pyodide.globals.set("__AUTOPEP8_INPUT_CODE__", inputCode);

  try {
    const result = await pyodide.runPythonAsync(`
import autopep8

_code = __AUTOPEP8_INPUT_CODE__
autopep8.fix_code(_code)
`);
    return String(result ?? "");
  } finally {
    try {
      pyodide.globals.delete("__AUTOPEP8_INPUT_CODE__");
    } catch (err) {}
  }
}

async function runAutopep8InWorker(code) {
  if (!pyodide || !isReady) {
    throw new Error("Pyodide non prêt dans le worker.");
  }

  await ensureAutopep8ReadyInWorker();

  const inputCode = String(code ?? "");
  pyodide.globals.set("__AUTOPEP8_INPUT_CODE__", inputCode);

  try {
    const result = await pyodide.runPythonAsync(`
import autopep8

_code = __AUTOPEP8_INPUT_CODE__
autopep8.fix_code(_code)
`);
    return String(result ?? "");
  } finally {
    try {
      pyodide.globals.delete("__AUTOPEP8_INPUT_CODE__");
    } catch (err) {
      // rien
    }
  }
}
*/

async function installModuleInWorker(moduleName) {
  if (!pyodide || !isReady) {
    throw new Error("Pyodide non prêt dans le worker.");
  }

  const safeName = String(moduleName || "").trim();
  if (!safeName) {
    throw new Error("Nom de module manquant.");
  }

  await pyodide.loadPackage("micropip");

  pyodide.globals.set("__INSTALL_MODULE_NAME__", safeName);
  try {
    await pyodide.runPythonAsync(`
import micropip
await micropip.install(__INSTALL_MODULE_NAME__)
`);
    return true;
  } finally {
    try {
      pyodide.globals.delete("__INSTALL_MODULE_NAME__");
    } catch (err) {}
  }
}




function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function waitForInputFromMain(promptText) {
  return new Promise((resolve, reject) => {
    inputRequestId += 1;
    const id = inputRequestId;

    pendingInputResolvers.set(id, { resolve, reject });

    post("input_request", {
      requestId: id,
      prompt: String(promptText ?? "")
    });
  });
}


function sendImageBase64(base64Png) {
  post("image", {
    base64: String(base64Png || "")
  });
}

function sendHtmlOutput(htmlString, title, filename) {
  post("html_output", {
    html: String(htmlString || ""),
    title: String(title || "Affichage HTML"),
    filename: String(filename || "sortie.html")
  });
}

async function installDariushRuntime() {
  if (!pyodide) {
    throw new Error("Pyodide non initialisé");
  }

  pyodide.globals.set("js_show_image_base64", (base64Png) => {
    sendImageBase64(base64Png);
  });

  pyodide.globals.set("js_show_html", (htmlString, title, filename) => {
    sendHtmlOutput(htmlString, title, filename);
  });

  pyodide.globals.set("js_input_async", async (promptText) => {
    return await waitForInputFromMain(promptText);
  });

  // Écriture directe de stdout/stderr, SANS le batching par retour-ligne de
  // pyodide.setStdout({batched}) (Pyodide 0.23.4 ne vide jamais le tampon
  // partiel : le texte produit sans "\n" final, ex. print(..., end=''),
  // restait bloqué). Le tampon de lignes est géré côté Python par
  // __DariushOut__ dans execUserCodeBlock, qui contrôle son propre flush.
  pyodide.globals.set("js_stdout_write", (text) => {
    post("stdout", { text: String(text ?? "") });
  });

  pyodide.globals.set("js_stderr_write", (text) => {
    post("stderr", { text: String(text ?? "") });
  });
}

function detectNeededPyodidePackages(code) {
  const src = String(code || "");
  const packages = new Set();

  if (/\bimport\s+PIL\b/.test(src) || /\bfrom\s+PIL\s+import\b/.test(src)) {
    packages.add("pillow");
  }

  if (/\bimport\s+matplotlib\b/.test(src) || /\bfrom\s+matplotlib\b/.test(src)) {
    packages.add("matplotlib");
  }

  return [...packages];
}

async function installImagePatches() {
  if (!pyodide) {
    throw new Error("Pyodide non initialisé");
  }

  await pyodide.runPythonAsync(`
import io
import base64
import builtins

def _install_pillow_show_patch():
    try:
        from PIL import Image
    except Exception:
        return

    def _dariush_show(self, *args, **kwargs):
        buffer = io.BytesIO()
        self.save(buffer, format="PNG")
        data = base64.b64encode(buffer.getvalue()).decode("ascii")
        builtins.js_show_image_base64(data)

    Image.Image.show = _dariush_show

def _install_matplotlib_show_patch():
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return

    def _dariush_matplotlib_show(*args, **kwargs):
        figure_numbers = plt.get_fignums()

        for num in figure_numbers:
            fig = plt.figure(num)
            buffer = io.BytesIO()
            fig.savefig(buffer, format="PNG", bbox_inches="tight")
            data = base64.b64encode(buffer.getvalue()).decode("ascii")
            builtins.js_show_image_base64(data)

        plt.close("all")

    plt.show = _dariush_matplotlib_show

def _install_folium_display_patch():
    try:
        import folium
    except Exception:
        return

    def _dariush_folium_display(self, *args, **kwargs):
        try:
            html_str = self._repr_html_()
        except Exception:
            html_str = self.get_root().render()
        js_show_html(html_str, "Carte folium", "carte.html")

    folium.Map.display = _dariush_folium_display

_install_pillow_show_patch()
_install_matplotlib_show_patch()
_install_folium_display_patch()
`);
}

 function splitStarImports(code) {
  const lines = String(code || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const starImports = [];
  const mainLines = [];

  for (const rawLine of lines) {
    const line = String(rawLine || "");

    if (/^\s*from\s+[A-Za-z0-9_\.]+\s+import\s*\*\s*(#.*)?$/.test(line)) {
      starImports.push(line);
    } else {
      mainLines.push(line);
    }
  }

  return {
    starImports: starImports.join("\n"),
    mainCode: mainLines.join("\n")
  };
}
  
async function ensurePackagesForCode(code) {
  if (!pyodide) {
    throw new Error("Pyodide non initialisé");
  }

  const src = String(code || "");
  if (!src.trim()) return;

  try {
    await pyodide.loadPackagesFromImports(src, {
      messageCallback: () => {},
      errorCallback: () => {}
    });
  } catch (err) {
    post("stderr", {
      text: "Avertissement loadPackagesFromImports : " + (err?.message || String(err))
    });
  }

  const extras = detectNeededPyodidePackages(src);
  if (extras.length > 0) {
    await pyodide.loadPackage(extras);
  }

  await installImagePatches();
}

async function resetPythonState() {
  if (!pyodide) {
    post("error", { message: "Pyodide non prêt dans le worker." });
    return;
  }

  try {
    await installDariushRuntime();

    await pyodide.runPythonAsync(`
import builtins
import ast

builtins.js_show_image_base64 = js_show_image_base64
builtins.js_input_async = js_input_async

async def _worker_input(prompt=""):
    return await builtins.js_input_async(prompt)

builtins.input = _worker_input

if "__dariush_globals__" not in globals():
    __dariush_globals__ = {
        "__name__": "__main__",
        "__builtins__": builtins,
    }
else:
    __dariush_globals__.clear()
    __dariush_globals__.update({
        "__name__": "__main__",
        "__builtins__": builtins,
    })

def __dariush_add_target_names__(target, out):
    if isinstance(target, ast.Name):
        out.add(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            __dariush_add_target_names__(elt, out)

def __dariush_collect_global_names__(source):
    tree = ast.parse(source)
    names = set()

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)

        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[0])

        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    continue
                names.add(alias.asname or alias.name)

        elif isinstance(node, ast.Assign):
            for target in node.targets:
                __dariush_add_target_names__(target, names)

        elif isinstance(node, ast.AnnAssign):
            __dariush_add_target_names__(node.target, names)

        elif isinstance(node, ast.AugAssign):
            __dariush_add_target_names__(node.target, names)

        elif isinstance(node, (ast.For, ast.AsyncFor)):
            __dariush_add_target_names__(node.target, names)

        elif isinstance(node, ast.With):
            for item in node.items:
                if item.optional_vars is not None:
                    __dariush_add_target_names__(item.optional_vars, names)

        elif isinstance(node, ast.AsyncWith):
            for item in node.items:
                if item.optional_vars is not None:
                    __dariush_add_target_names__(item.optional_vars, names)

    return sorted(name for name in names if isinstance(name, str) and name.isidentifier())
`);

    await installImagePatches();
    post("status", { message: "Mémoire Python réinitialisée" });
  } catch (err) {
    post("error", {
      message: err?.stack || err?.message || String(err)
    });
  }
}

async function initWorker() {
  try {
    post("status", { message: "Chargement de Pyodide dans le worker..." });

    //pyodide = await loadPyodide();
    pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });
    pyodide.setStdout({
      batched: (text) => {
        post("stdout", { text: String(text ?? "") });
      }
    });

    pyodide.setStderr({
      batched: (text) => {
        post("stderr", { text: String(text ?? "") });
      }
    });

    await installDariushRuntime();
    await resetPythonState();

    isReady = true;
    post("ready");
  } catch (err) {
    post("error", {
      message: "Erreur init worker: " + (err?.stack || err?.message || String(err))
    });
  }
}
      
async function writeFileToWorkerFs(filename, bytesArray) {
  if (!pyodide || !isReady) {
    throw new Error("Pyodide non prêt dans le worker.");
  }

  const safeName = String(filename || "").trim();
  if (!safeName) {
    throw new Error("Nom de fichier manquant.");
  }

  const bytes = new Uint8Array(bytesArray || []);
  pyodide.FS.writeFile(safeName, bytes);
}  




function errorLooksLikeMissingDependency(err) {
  if (!err) return false;

  // On ne recharge les pages précédentes QUE pour un NameError, c'est-à-dire
  // une globale ou une fonction définie ailleurs et pas encore exécutée.
  // Une SyntaxError, IndentationError, IndexError, erreur de boucle, etc.
  // ne doivent PAS déclencher le rechargement.

  // Cas normal : PythonError Pyodide → err.type contient le nom de la classe.
  if (String(err.type || "") === "NameError") return true;

  // Filet de sécurité si err.type est absent : on lit la 1re ligne du message,
  // en exigeant le mot exact "NameError" en début de ligne d'erreur.
  const message = String(err.message || err.toString?.() || err);
  if (/(^|\n)NameError\b/.test(message)) return true;

  return false;
}

function formatRunError(err) {
  if (err && err.type && err.message) {
    return err.type + ": " + err.message;
  }
  if (err && err.message) {
    return err.message;
  }
  return String(err);
}


// Convertit les tabulations d'INDENTATION en leur nombre d'espaces equivalent
// (saut au multiple de DARIUSH_TAB_WIDTH, exactement comme l'interprete Python).
// Ne touche qu'a l'indentation : un \t a l'interieur d'une chaine est preserve.
// Applique a l'identique au run normal ET au pas-a-pas => plus de TabError, et
// meme comportement dans les deux modes.
const DARIUSH_TAB_WIDTH = 8; // mettre 4 pour coller a l'indentUnit de l'editeur (voir note)

function normalizeLeadingTabs(code, tabWidth = DARIUSH_TAB_WIDTH) {
  return String(code == null ? "" : code)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(line => {
      const lead = (line.match(/^[ \t]*/) || [""])[0];
      if (lead.indexOf("\t") === -1) return line; // pas de tab d'indentation
      let col = 0;
      for (const ch of lead) {
        col += (ch === "\t") ? (tabWidth - (col % tabWidth)) : 1;
      }
      return " ".repeat(col) + line.slice(lead.length);
    })
    .join("\n");
}

async function execUserCodeBlock(code, options = {}) {
  const silent = !!options.silent;
  const source = normalizeLeadingTabs(code);  

  await installDariushRuntime();
  await ensurePackagesForCode(source);

  const { starImports, mainCode } = splitStarImports(source);

  pyodide.globals.set("__dariush_star_imports__", starImports);
  pyodide.globals.set("__dariush_user_source__", mainCode);
  pyodide.globals.set("__dariush_exec_silent__", silent);

  try {
    await pyodide.runPythonAsync(`
import textwrap as __tw__
import sys as __sys__
import io as __io__
import builtins as __bi__
__dariush_user_source__ = __tw__.dedent(__dariush_user_source__)

__dariush_names__ = __dariush_collect_global_names__(__dariush_user_source__)

if __dariush_star_imports__.strip():
    exec(__dariush_star_imports__, __dariush_globals__, __dariush_globals__)

__dariush_lines__ = ["async def __dariush_async_main__():"]

if __dariush_names__:
    __dariush_lines__.append("    global " + ", ".join(__dariush_names__))

_user_lines = __dariush_user_source__.split("\\n")

if len(_user_lines) == 0 or (len(_user_lines) == 1 and _user_lines[0].strip() == ""):
    __dariush_lines__.append("    pass")
else:
    for _line in _user_lines:
        __dariush_lines__.append("    " + _line)

__dariush_wrapped__ = "\\n".join(__dariush_lines__)

# Le code utilisateur tourne dans une fonction (__dariush_async_main__) pour
# gerer le await de input(). Probleme : exec()/eval() sans namespace explicite
# utilisent globals() ET locals() de l'appelant. Au vrai niveau module
# locals() is globals(), donc exec("x=..") ecrit dans les globales. Ici locals()
# est le namespace local jete de la fonction => la modif est perdue.
# On fournit donc un exec/eval qui, au niveau module SIMULE (frame ==
# __dariush_async_main__ avec nos globales), force locals = globals. Pour tout
# exec a l'interieur d'une fonction ecrite par l'eleve, on garde le comportement
# Python standard (globals/locals de la frame appelante).
def __dariush_exec__(source, glob=None, loc=None, *, __g=__dariush_globals__, __b=__bi__, __s=__sys__):
    if glob is None:
        __f = __s._getframe(1)
        glob = __f.f_globals
        if loc is None:
            if glob is __g and __f.f_code.co_name == "__dariush_async_main__":
                loc = glob
            else:
                loc = __f.f_locals
    elif loc is None:
        loc = glob
    return __b.exec(source, glob, loc)

def __dariush_eval__(source, glob=None, loc=None, *, __g=__dariush_globals__, __b=__bi__, __s=__sys__):
    if glob is None:
        __f = __s._getframe(1)
        glob = __f.f_globals
        if loc is None:
            if glob is __g and __f.f_code.co_name == "__dariush_async_main__":
                loc = glob
            else:
                loc = __f.f_locals
    elif loc is None:
        loc = glob
    return __b.eval(source, glob, loc)

__dariush_globals__["exec"] = __dariush_exec__
__dariush_globals__["eval"] = __dariush_eval__

# Flux maison : bufferise par ligne, emet immediatement chaque ligne complete,
# et emet le reste (texte sans "\\n" final, ex. print(..., end='')) au flush.
class __DariushOut__:
    def __init__(self, cb):
        self._cb = cb
        self._buf = ""
    def write(self, s):
        text = str(s)
        self._buf += text
        nl = self._buf.rfind("\\n")
        if nl >= 0:
            self._cb(self._buf[:nl + 1])
            self._buf = self._buf[nl + 1:]
        return len(text)
    def flush(self):
        if self._buf:
            self._cb(self._buf)
            self._buf = ""
    def isatty(self):
        return False

# En mode silencieux (rejeu des pages précédentes en cache) :
#  - stdout/stderr masqués (pas de print parasite dans la fenêtre)
#  - sorties graphiques neutralisées (pas de fenêtre image / matplotlib / HTML)
# Les input() et random NE sont PAS touchés : ils s'exécutent normalement.
__dariush_old_out__ = __sys__.stdout
__dariush_old_err__ = __sys__.stderr
__dariush_old_img__ = getattr(__bi__, "js_show_image_base64", None)
__dariush_old_html__ = getattr(__bi__, "js_show_html", None)

if __dariush_exec_silent__:
    __sys__.stdout = __io__.StringIO()
    __sys__.stderr = __io__.StringIO()
    __bi__.js_show_image_base64 = lambda *a, **k: None
    __bi__.js_show_html = lambda *a, **k: None
else:
    __sys__.stdout = __DariushOut__(js_stdout_write)
    __sys__.stderr = __DariushOut__(js_stderr_write)

try:
    exec(__dariush_wrapped__, __dariush_globals__, __dariush_globals__)
    await __dariush_globals__["__dariush_async_main__"]()
finally:
    # Vide le tampon (texte sans "\\n" final). En silencieux c'est un StringIO :
    # sans effet visible. En normal, __DariushOut__.flush() emet le reste.
    try:
        __sys__.stdout.flush()
        __sys__.stderr.flush()
    except Exception:
        pass
    __sys__.stdout = __dariush_old_out__
    __sys__.stderr = __dariush_old_err__
    if __dariush_exec_silent__:
        if __dariush_old_img__ is not None:
            __bi__.js_show_image_base64 = __dariush_old_img__
        if __dariush_old_html__ is not None:
            __bi__.js_show_html = __dariush_old_html__

__dariush_globals__.pop("__dariush_async_main__", None)

globals().pop("__dariush_names__", None)
globals().pop("__dariush_lines__", None)
globals().pop("__dariush_wrapped__", None)
globals().pop("_user_lines", None)
globals().pop("_line", None)
globals().pop("__dariush_user_source__", None)
globals().pop("__dariush_star_imports__", None)
globals().pop("__dariush_exec_silent__", None)
globals().pop("__dariush_old_out__", None)
globals().pop("__dariush_old_err__", None)
globals().pop("__dariush_old_img__", None)
globals().pop("__dariush_old_html__", None)
globals().pop("__DariushOut__", None)
globals().pop("__dariush_exec__", None)
globals().pop("__dariush_eval__", None)
globals().pop("__tw__", None)
globals().pop("__sys__", None)
globals().pop("__io__", None)
globals().pop("__bi__", None)
`);
  } finally {
    try {
      pyodide.globals.delete("__dariush_exec_silent__");
    } catch (e) {}
  }
}





async function runCode(code, contextCode = "") {
  if (!pyodide || !isReady) {
    post("error", { message: "Pyodide non prêt dans le worker." });
    return;
  }

  const source = String(code || "");
  const previousPagesCode = String(contextCode || "");

  try {
    // 1er essai : exécution normale de la page active, sur l'état courant.
    await execUserCodeBlock(source, { silent: false });
  } catch (err) {
    // On ne recharge les pages précédentes QUE pour un NameError (globale ou
    // fonction inconnue), et seulement si on dispose du code des pages
    // précédentes. Toute autre erreur s'affiche directement.
    const needsPrevious =
      errorLooksLikeMissingDependency(err) && previousPagesCode.trim();

   if (!needsPrevious) {
      post("error", { message: formatRunError(err) });
      return; // le post("done") est assuré par le finally ci-dessous
    }

    try {
      // Message d'information affiché en tête de la fenêtre d'exécution.
      post("info", {
        message:
          "Information : Le débogueur a chargé les pages précédentes pour résoudre une dépendance."
      });

      // On repart d'un état Python propre (le plus sûr : pas d'effet
      // de bord cumulé par le 1er essai qui a partiellement tourné).
      await resetPythonState();
      await installDariushRuntime();
      await ensurePackagesForCode(previousPagesCode + "\n" + source);

      // Marqueur DEBUT du rejeu de contexte : a partir d'ici le thread
      // principal arme un chien de garde (une page precedente peut boucler).
      post("run_replay_start");

      // On rejoue chaque page précédente, dans l'ordre croissant, en cache
      // (sortie masquée). Si une page plante, on passe à la suivante et on
      // mémorise son numéro pour le signaler à l'élève.
      const pageSep = "\n###__DARIUSH_PAGE_SEP__###\n";
      const previousPages = previousPagesCode.includes(pageSep)
        ? previousPagesCode.split(pageSep)
        : [previousPagesCode];

      const failedPages = [];

      for (let i = 0; i < previousPages.length; i++) {
        const pageCode = previousPages[i];
        if (!String(pageCode || "").trim()) continue;
        try {
          await execUserCodeBlock(pageCode, { silent: true });
        } catch (pageErr) {
          // Tolérant : une page précédente qui échoue ne bloque pas la suite.
          // L'index i correspond à la page numéro i+1 dans le notebook.
          failedPages.push(i + 1);
        }
      }

      // Marqueur FIN du rejeu de contexte : le chien de garde est desarme
      // AVANT la nouvelle tentative de la page active (qui, elle, peut
      // legitimement attendre un input() ou etre longue).
      post("run_replay_end");

      // S'il y a eu des pages précédentes en échec, on en informe l'élève.
      if (failedPages.length > 0) {
        const libelle =
          failedPages.length === 1
            ? "La page précédente suivante n'a pas pu être exécutée : "
            : "Les pages précédentes suivantes n'ont pas pu être exécutées : ";
        post("info", {
          message: libelle + failedPages.join(", ")
        });
      }

      // Nouvel essai de la page active, cette fois avec les globales
      // nouvellement reconstruites. Sortie visible.
      await execUserCodeBlock(source, { silent: false });
    } catch (retryErr) {
      post("error", { message: formatRunError(retryErr) });
    }
  } finally {
    post("done");
  }
}
/*
self.onmessage = async (event) => {
  const data = event.data || {};

  try {
    if (data.type === "init") {
      await initWorker();
      return;
    }

    if (data.type === "run") {
      await runCode(data.code);
      return;
    }

    if (data.type === "input_response") {
      const entry = pendingInputResolvers.get(data.requestId);
      if (!entry) return;

      pendingInputResolvers.delete(data.requestId);
      entry.resolve(String(data.value ?? ""));
      return;
    }

    if (data.type === "write_file") {
  await writeFileToWorkerFs(data.filename, data.bytes);
  post("file_written", { filename: data.filename });
  return;
}
    
    if (data.type === "build_debug_snapshots") {
  const snapshots = await buildDebugSnapshotsInWorker(data.code, data.contextCode || "");
  post("debug_snapshots_result", { snapshots });
  return;
}
    
    if (data.type === "input_cancel") {
      const entry = pendingInputResolvers.get(data.requestId);
      if (!entry) return;

      pendingInputResolvers.delete(data.requestId);
      entry.reject(new Error("Saisie annulée"));
      return;
    }

    if (data.type === "reset_python_state") {
      await resetPythonState();
      return;
    }
   if (data.type === "ensure_autopep8") {
  await ensureAutopep8ReadyInWorker();
  post("autopep8_ready");
  return;
}

if (data.type === "run_autopep8") {
  const fixed = await runAutopep8InWorker(data.code);
  post("autopep8_result", { fixed });
  return;
}

    post("error", { message: "Message inconnu reçu par worker." });
  } catch (err) {
    post("error", {
      message: "Erreur globale worker: " + (err?.message || err?.stack || String(err))
    });
  }
};
*/
self.onmessage = async (event) => {
  const data = event.data || {};

  try {
    if (data.type === "init") {
      await initWorker();
      return;
    }

    


if (data.type === "run") {
      await runCode(data.code, data.contextCode || "");
      return;
    }

    if (data.type === "input_response") {
      const entry = pendingInputResolvers.get(data.requestId);
      if (!entry) return;

      pendingInputResolvers.delete(data.requestId);
      entry.resolve(String(data.value ?? ""));
      return;
    }

    if (data.type === "write_file") {
      await writeFileToWorkerFs(data.filename, data.bytes);
      post("file_written", { filename: data.filename });
      return;
    }
    
    if (data.type === "build_debug_snapshots") {
      const snapshots = await buildDebugSnapshotsInWorker(data.code, data.contextCode || "", data.activePageIndex || 0);
      post("debug_snapshots_result", { snapshots });
      return;
    }
    
    if (data.type === "input_cancel") {
      const entry = pendingInputResolvers.get(data.requestId);
      if (!entry) return;

      pendingInputResolvers.delete(data.requestId);
      entry.reject(new Error("Saisie annulée"));
      return;
    }

    /*if (data.type === "reset_python_state") {
      await resetPythonState();
      return;
    }*/
    if (data.type === "reset_python_state") {
     
      await resetPythonState();
      post("reset_python_state_done");
      return;
    }

    if (data.type === "ensure_autopep8") {
      await ensureAutopep8ReadyInWorker();
      post("autopep8_ready");
      return;
    }

    if (data.type === "run_autopep8") {
      const fixed = await runAutopep8InWorker(data.code);
      post("autopep8_result", { fixed });
      return;
    }

    if (data.type === "install_module") {
      const moduleName = String(data.moduleName || "");
      try {
        await installModuleInWorker(moduleName);
        post("install_module_result", { moduleName, success: true });
      } catch (err) {
        post("install_module_result", {
          moduleName,
          success: false,
          error: err?.message || String(err)
        });
      }
      return;
    }

    post("error", { message: "Message inconnu reçu par worker." });
  } catch (err) {
    post("error", {
      message: "Erreur globale worker: " + (err?.message || err?.stack || String(err))
    });
  }
};