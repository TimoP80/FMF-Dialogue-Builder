import { useState, useEffect } from 'react';
import { Settings } from 'lucide-react';
import { FileDown, FileText, Loader2, Play, Save, FolderOpen, AlertTriangle, Code, Workflow } from 'lucide-react';
import { generateDialogueJSON, fmfToString } from './lib/gemini';
import { motion, AnimatePresence } from 'motion/react';
import DialogueGraph from './components/DialogueGraph';

import { COMMAND_MACROS } from './lib/commands';

const FMFHighlighter = ({ code, brokenLinks }: { code: string, brokenLinks: Set<string> }) => {
  if (!code) return null;
  // A regex to match comments, linkto sequences explicitly, strings, numbers/booleans, and keywords
  const keywords = ['NPCName', 'Location', 'Description', 'Unknown_Desc', 'Known_Desc', 'Detailed_Desc', 'start_conditions', 'default_condition', 'cond', 'target_node', 'Node', 'is_wtg', 'NPCText', 'options', 'playertext', 'linkto', 'notes', 'int', 'Reaction', 'REACTION_NEUTRAL', 'REACTION_GOOD', 'REACTION_BAD', 'custom_proc', 'associate_node', 'define_skill_check', 'skill_num', 'difficulty_modifier', 'onsuccess', 'onfailure', ...COMMAND_MACROS].join('|');
  const regex = new RegExp(`(/\\*[\\s\\S]*?\\*/)|(linkto "([^"]+)")|("(?:\\\\"|[^"])*")|(\\b(?:true|false|-?\\d+)\\b)|(\\b(?:${keywords}|PID_[A-Z0-9_]+|GVAR_[A-Z0-9_]+)\\b)`, 'g');

  let lastIndex = 0;
  const elements = [];
  let match;

  while ((match = regex.exec(code)) !== null) {
    if (match.index > lastIndex) {
      elements.push(code.substring(lastIndex, match.index));
    }
    
    if (match[1]) {
      // Comment
      elements.push(<span key={`comment-${match.index}`} className="text-green-700 italic">{match[1]}</span>);
    } else if (match[2]) {
      // linkto "..."
      const target = match[3];
      const isBroken = brokenLinks.has(target);
      elements.push(
        <span key={`linkto-${match.index}`}>
          <span className="text-green-400">linkto </span>
          <span className={isBroken ? "text-red-500 bg-red-900/40 underline decoration-red-500/50 underline-offset-2" : "text-green-300"}>
            "{target}"
          </span>
          {isBroken && <span className="text-red-500 ml-1" title="Broken Link!">⚠</span>}
        </span>
      );
    } else if (match[4]) {
      // String
      elements.push(<span key={`string-${match.index}`} className="text-green-300">{match[4]}</span>);
    } else if (match[5]) {
      // Number/Boolean
      elements.push(<span key={`literal-${match.index}`} className="text-amber-500">{match[5]}</span>);
    } else if (match[6]) {
      // Keyword
      elements.push(<span key={`keyword-${match.index}`} className="text-green-400 font-bold">{match[6]}</span>);
    }
    
    lastIndex = regex.lastIndex;
  }
  
  if (lastIndex < code.length) {
    elements.push(code.substring(lastIndex));
  }

  return <>{elements}</>;
};

export default function App() {
  const [prompt, setPrompt] = useState('');
  const [maxNodes, setMaxNodes] = useState<number>(5);
  const [maxOptions, setMaxOptions] = useState<number>(4);
  const [autoSaveInterval, setAutoSaveInterval] = useState<number>(60);
  const [aiModel, setAiModel] = useState<string>('gemini-2.5-flash');
  const [customGvars, setCustomGvars] = useState<string[]>([]);
  const [newGvar, setNewGvar] = useState('');
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [output, setOutput] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [brokenLinks, setBrokenLinks] = useState<Set<string>>(new Set());
  const [unreachableNodes, setUnreachableNodes] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<'code' | 'graph'>('code');

  useEffect(() => {
    if (autoSaveInterval === 0 || (!prompt && !output)) return;
    
    const timer = setInterval(() => {
      localStorage.setItem('fmf_dialogue_save', JSON.stringify({ prompt, output, maxNodes, maxOptions, autoSaveInterval, aiModel, customGvars }));
      setLastSaved(new Date());
    }, autoSaveInterval * 1000);

    return () => clearInterval(timer);
  }, [prompt, output, maxNodes, maxOptions, autoSaveInterval, aiModel, customGvars]);

  useEffect(() => {
    if (!output) {
      setWarnings([]);
      setBrokenLinks(new Set());
      return;
    }
    
    const startNodes = new Set<string>();
    const condNodeRegex = /cond target_node "([^"]+)"/g;
    let match;
    while ((match = condNodeRegex.exec(output)) !== null) {
      startNodes.add(match[1]);
    }

    const nodeNames = new Set<string>(['done', 'combat', 'combat_node', 'Node_FirstIntro']); 
    const nodesInfo = new Map<string, Set<string>>();

    // Add skill checks to nodeNames so links to them are considered valid, and add their onsuccess/onfailure to edges
    const skillCheckRegex = /define_skill_check\s+(\w+)\s*\{([^}]*)\}/g;
    let scMatch;
    while((scMatch = skillCheckRegex.exec(output)) !== null) {
      const scName = scMatch[1];
      nodeNames.add(scName);
      
      const targets = new Set<string>();
      const propsStr = scMatch[2];
      
      const onsuccMatch = propsStr.match(/onsuccess\s*=>\s*([\w_]+)/);
      if (onsuccMatch) targets.add(onsuccMatch[1]);
      
      const onfailMatch = propsStr.match(/onfailure\s*=>\s*([\w_]+)/);
      if (onfailMatch) targets.add(onfailMatch[1]);

      nodesInfo.set(scName, targets);
    }

    const chunks = output.split('Node "');
    for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        const idMatch = chunk.match(/^([^"]+)"/);
        if (idMatch) {
            const nodeId = idMatch[1];
            nodeNames.add(nodeId);
            
            const targets = new Set<string>();
            const optionsMatch = chunk.match(/options\s*\{([\s\S]*?)\}/);
            if (optionsMatch) {
               const optionsStr = optionsMatch[1];
               const optRegex = /linkto\s+"([^"]+)"/g;
               let optMatch;
               while((optMatch = optRegex.exec(optionsStr)) !== null) {
                   targets.add(optMatch[1]);
               }
            }
            nodesInfo.set(nodeId, targets);
        }
    }

    const currentWarnings = new Set<string>();
    const broken = new Set<string>();
    
    startNodes.forEach(target => {
        if (!nodeNames.has(target)) {
            broken.add(target);
            currentWarnings.add(`Start condition links to missing node: [${target}]`);
        }
    });

    nodesInfo.forEach((targets, sourceNode) => {
        targets.forEach(target => {
            if (!nodeNames.has(target)) {
                broken.add(target);
                currentWarnings.add(`Node [${sourceNode}] has broken link to: [${target}]`);
            }
        });
    });

    // Detect cycles via DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles = new Set<string>();

    const detectCycle = (node: string, path: string[]) => {
        if (!visited.has(node)) {
            visited.add(node);
            recursionStack.add(node);
            
            const neighbors = nodesInfo.get(node);
            if (neighbors) {
                for (const neighbor of neighbors) {
                    if (!visited.has(neighbor)) {
                        detectCycle(neighbor, [...path, node]);
                    } else if (recursionStack.has(neighbor)) {
                        const cyclePath = [...path, node, neighbor];
                        const cycleIndex = cyclePath.indexOf(neighbor);
                        const actualCycle = cyclePath.slice(cycleIndex).join(' -> ');
                        cycles.add(`Cycle detected: ${actualCycle}`);
                    }
                }
            }
        }
        recursionStack.delete(node);
    };

    startNodes.forEach(node => detectCycle(node, []));
    nodesInfo.forEach((_, node) => {
        if (!visited.has(node)) detectCycle(node, []);
    });

    cycles.forEach(cycle => currentWarnings.add(cycle));

    // Detect unreachable nodes
    const reachableNodes = new Set<string>();
    const dfsReach = (node: string) => {
        if (!reachableNodes.has(node)) {
            reachableNodes.add(node);
            const neighbors = nodesInfo.get(node);
            if (neighbors) {
                for (const n of neighbors) {
                    if (nodeNames.has(n)) {
                        dfsReach(n);
                    }
                }
            }
        }
    };

    startNodes.forEach(node => {
        if (nodeNames.has(node)) dfsReach(node);
    });

    const unreachable = new Set<string>();
    nodesInfo.forEach((_, node) => {
        if (!reachableNodes.has(node)) {
            unreachable.add(node);
            currentWarnings.add(`Unreachable isolated node: [${node}]`);
        }
    });

    setBrokenLinks(broken);
    setUnreachableNodes(unreachable);
    setWarnings(Array.from(currentWarnings));
  }, [output]);

  const setNodesValue = (val: string) => setMaxNodes(Number(val));
  const setOptionsValue = (val: string) => setMaxOptions(Number(val));

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setIsGenerating(true);
    try {
      const data = await generateDialogueJSON(prompt, maxNodes, maxOptions, aiModel, customGvars);
      const fmfString = fmfToString(data);
      setOutput(fmfString);
    } catch (err) {
      console.error(err);
      alert('Failed to generate dialogue. Check the console for more details.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExport = () => {
    if (!output) return;
    
    let filename = "dialogue.fmf";
    const npcMatch = output.match(/NPCName\s+"([^"]+)"/);
    if (npcMatch && npcMatch[1]) {
        filename = `${npcMatch[1].replace(/[^a-zA-Z0-9_\-]/g, '_')}.fmf`;
    }
    
    const blob = new Blob([output], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSave = () => {
    if (!prompt && !output) return;
    localStorage.setItem('fmf_dialogue_save', JSON.stringify({ prompt, output, maxNodes, maxOptions, autoSaveInterval, aiModel, customGvars }));
    setLastSaved(new Date());
    alert('Project saved to browser storage.'); // Simple feedback
  };

  const handleLoad = () => {
    const saved = localStorage.getItem('fmf_dialogue_save');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.prompt !== undefined) setPrompt(parsed.prompt);
        if (parsed.output !== undefined) setOutput(parsed.output);
        if (parsed.maxNodes !== undefined) setMaxNodes(parsed.maxNodes);
        if (parsed.maxOptions !== undefined) setMaxOptions(parsed.maxOptions);
        if (parsed.autoSaveInterval !== undefined) setAutoSaveInterval(parsed.autoSaveInterval);
        if (parsed.aiModel !== undefined) setAiModel(parsed.aiModel);
        if (parsed.customGvars !== undefined) setCustomGvars(parsed.customGvars);
      } catch (err) {
        console.error('Failed to load project from local storage.', err);
      }
    } else {
      alert('No saved project found.');
    }
  };

  const handleAddGvar = () => {
    const trimmed = newGvar.trim().toUpperCase();
    if (trimmed && !customGvars.includes(trimmed) && (!trimmed.startsWith('GVAR_') ? !customGvars.includes(`GVAR_${trimmed}`) : true)) {
      if (!trimmed.startsWith('GVAR_')) {
        setCustomGvars([...customGvars, `GVAR_${trimmed}`]);
      } else {
        setCustomGvars([...customGvars, trimmed]);
      }
      setNewGvar('');
    }
  };

  const handleRemoveGvar = (gvar: string) => {
    setCustomGvars(customGvars.filter(g => g !== gvar));
  };

  return (
    <div className="min-h-screen grit-bg text-green-500 selection:bg-green-500/30 crt-effect font-mono overflow-auto flex flex-col">
      <header className="border-b-2 border-green-500/40 bg-black/80 backdrop-blur-sm sticky top-0 z-10 shadow-[0_4px_10px_rgba(34,197,94,0.1)]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-glow">
            <FileText className="w-7 h-7 text-green-400" />
            <h1 className="font-bold text-2xl tracking-widest text-green-400 uppercase">RobCo FMF TermLink</h1>
          </div>
          <div className="text-green-700 text-sm animate-pulse tracking-widest uppercase">Sys_Online</div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 grid md:grid-cols-[1fr_1.2fr] gap-8 flex-1 w-full relative z-20">
        {/* Left Column: Input */}
        <div className="flex flex-col gap-6">
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-green-400 mb-1 tracking-widest uppercase text-glow">&gt; Runtime Params</h2>
              <p className="text-sm text-green-700 uppercase tracking-widest leading-relaxed">
                Input scenario directive for FMF output generation.
              </p>
            </div>
            
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="e.g. A gritty scavenger sitting in a radioactive crater, refusing to part with his junk..."
              className="w-full h-64 bg-black/60 border-2 border-green-500/40 p-4 text-green-400 placeholder:text-green-800 focus:outline-none focus:border-green-400 focus:ring-1 focus:ring-green-400 resize-y transition-all font-mono text-lg text-glow"
            />

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-black/40 p-4 border-2 border-green-500/30 font-mono">
              <div className="space-y-2 col-span-2 sm:col-span-1">
                <label className="text-sm font-bold text-green-600 uppercase tracking-widest flex items-center gap-1.5">
                  <Settings className="w-4 h-4" /> Max Nodes
                </label>
                <input 
                  type="number" 
                  min="2" 
                  max="20" 
                  value={maxNodes} 
                  onChange={e => setMaxNodes(Number(e.target.value))}
                  className="w-full bg-black border-2 border-green-500/40 p-2.5 text-green-400 focus:outline-none focus:border-green-400 font-mono text-lg text-center"
                />
              </div>
              <div className="space-y-2 col-span-2 sm:col-span-1">
                <label className="text-sm font-bold text-green-600 uppercase tracking-widest flex items-center gap-1.5">
                  <Settings className="w-4 h-4" /> Max Options
                </label>
                <input 
                  type="number" 
                  min="1" 
                  max="6" 
                  value={maxOptions} 
                  onChange={e => setMaxOptions(Number(e.target.value))}
                  className="w-full bg-black border-2 border-green-500/40 p-2.5 text-green-400 focus:outline-none focus:border-green-400 font-mono text-lg text-center"
                />
              </div>
              <div className="space-y-2 col-span-2 sm:col-span-1">
                <label className="text-sm font-bold text-green-600 uppercase tracking-widest flex items-center gap-1.5">
                  <Settings className="w-4 h-4" /> Auto-Save
                </label>
                <select
                  value={autoSaveInterval}
                  onChange={e => setAutoSaveInterval(Number(e.target.value))}
                  className="w-full bg-black border-2 border-green-500/40 p-3 text-green-400 focus:outline-none focus:border-green-400 font-mono text-base text-center appearance-none cursor-pointer"
                >
                  <option value={0}>Off</option>
                  <option value={15}>15 sec</option>
                  <option value={30}>30 sec</option>
                  <option value={60}>1 min</option>
                  <option value={300}>5 min</option>
                </select>
              </div>
              <div className="space-y-2 col-span-2 sm:col-span-1">
                <label className="text-sm font-bold text-green-600 uppercase tracking-widest flex items-center gap-1.5">
                  <Settings className="w-4 h-4" /> AI Model
                </label>
                <select
                  value={aiModel}
                  onChange={e => setAiModel(e.target.value)}
                  className="w-full bg-black border-2 border-green-500/40 p-3 text-green-400 focus:outline-none focus:border-green-400 font-mono text-base text-center appearance-none cursor-pointer"
                  title="Choose between fast/free model or advanced model"
                >
                  <option value="gemini-2.5-flash">2.5-Flash (Free)</option>
                  <option value="gemini-2.5-pro">2.5-Pro (Better)</option>
                  <option value="gemini-3.1-pro-preview">3.1-Pro (Best)</option>
                </select>
              </div>
            </div>

            <div className="space-y-2 bg-black/40 p-4 border-2 border-green-500/30 font-mono">
              <label className="text-sm font-bold text-green-600 uppercase tracking-widest flex items-center gap-1.5">
                <Settings className="w-4 h-4" /> Custom GVARs
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newGvar}
                  onChange={e => setNewGvar(e.target.value)}
                  placeholder="GVAR_NAME"
                  className="flex-1 bg-black border-2 border-green-500/40 p-2.5 text-green-400 focus:outline-none focus:border-green-400 font-mono text-base"
                  onKeyDown={e => { if(e.key === 'Enter') handleAddGvar() }}
                />
                <button 
                  onClick={handleAddGvar} 
                  className="bg-green-500/20 hover:bg-green-500/30 text-green-400 border-2 border-green-500/50 px-4 font-bold uppercase tracking-widest"
                >
                  Add
                </button>
              </div>
              {customGvars.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {customGvars.map(gvar => (
                    <span key={gvar} className="bg-black/80 text-green-300 px-2 py-1 flex items-center gap-2 border border-green-500/50 text-sm">
                      {gvar}
                      <button onClick={() => handleRemoveGvar(gvar)} className="text-red-400 hover:text-red-300 hover:bg-red-400/20 rounded-full px-1.5 leading-none transition-colors">
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <button
                onClick={handleGenerate}
                disabled={isGenerating || !prompt.trim()}
                className="w-full py-4 px-6 bg-green-500 hover:bg-green-400 focus:bg-green-400 disabled:bg-green-900/30 disabled:text-green-700 text-black font-bold uppercase tracking-widest text-xl transition-all flex items-center justify-center gap-3 cursor-pointer disabled:cursor-not-allowed border-2 border-transparent disabled:border-green-900/50"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-6 h-6 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Play className="w-6 h-6 fill-current" />
                    Initialize Output
                  </>
                )}
              </button>
              
              {lastSaved && (
                <p className="text-right text-xs font-bold text-green-700 mt-1 uppercase tracking-widest">
                  Sys_Backup: {lastSaved.toLocaleTimeString()}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Output */}
        <div className="flex flex-col h-full bg-black/60 border-2 border-green-500/40 border-glow relative min-h-[500px]">
          <div className="flex flex-wrap items-center justify-between p-3 border-b-2 border-green-500/30 bg-green-900/20">
            <h3 className="font-bold text-lg text-green-400 flex items-center gap-2 mr-4 uppercase tracking-widest text-glow">
              <FileDown className="w-5 h-5" /> Out_Stream
            </h3>

            {/* Toggle View */}
            <div className="flex bg-black p-1 border-2 border-green-500/30 mr-auto">
              <button
                onClick={() => setViewMode('code')}
                className={`flex items-center gap-2 px-4 py-1.5 text-sm font-bold uppercase tracking-widest transition-colors ${viewMode === 'code' ? 'bg-green-500 text-black shadow-sm' : 'text-green-600 hover:text-green-400'}`}
              >
                <Code className="w-4 h-4" />
                Raw
              </button>
              <button
                onClick={() => setViewMode('graph')}
                className={`flex items-center gap-2 px-4 py-1.5 text-sm font-bold uppercase tracking-widest transition-colors ${viewMode === 'graph' ? 'bg-green-500 text-black shadow-sm' : 'text-green-600 hover:text-green-400'}`}
              >
                <Workflow className="w-4 h-4" />
                Map
              </button>
            </div>
            
            {warnings.length > 0 && (
              <div 
                className="flex bg-red-900/40 text-red-500 text-xs font-bold uppercase tracking-widest px-3 py-1.5 border-2 border-red-500/50 items-center gap-2 mx-4 cursor-help" 
                title={warnings.join('\n')}
              >
                <AlertTriangle className="w-4 h-4" />
                <span>ERR: {warnings.length}</span>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={handleLoad}
                disabled={isGenerating}
                className="cursor-pointer font-bold text-sm uppercase tracking-widest px-3 py-2 bg-black hover:bg-green-900/40 disabled:opacity-50 text-green-500 transition-colors flex items-center gap-2 disabled:cursor-not-allowed border-2 border-green-500/30"
                title="Load from Browser Storage"
              >
                <FolderOpen className="w-4 h-4" />
                <span className="hidden xl:inline">Load</span>
              </button>
              <button
                onClick={handleSave}
                disabled={(!output && !prompt) || isGenerating}
                className="cursor-pointer font-bold text-sm uppercase tracking-widest px-3 py-2 bg-black hover:bg-green-900/40 disabled:opacity-50 text-green-500 transition-colors flex items-center gap-2 disabled:cursor-not-allowed border-2 border-green-500/30"
                title="Save to Browser Storage"
              >
                <Save className="w-4 h-4" />
                <span className="hidden xl:inline">Store</span>
              </button>
              <button
                onClick={handleExport}
                disabled={!output || isGenerating}
                className="cursor-pointer font-bold text-sm uppercase tracking-widest px-4 py-2 bg-green-500 hover:bg-green-400 disabled:bg-green-900/30 disabled:text-green-700 text-black transition-colors flex items-center gap-2 disabled:cursor-not-allowed border-2 border-green-400"
              >
                Export .FMF
              </button>
            </div>
          </div>
          
          <div className="flex-1 overflow-auto relative p-4 bg-black/40">
            <AnimatePresence mode="popLayout">
              {output ? (
                viewMode === 'code' ? (
                  <motion.pre
                    key="code-view"
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    className="text-lg font-mono text-green-400 whitespace-pre-wrap flex-1"
                  >
                    <FMFHighlighter code={output} brokenLinks={brokenLinks} />
                  </motion.pre>
                ) : (
                  <motion.div
                    key="graph-view"
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    className="absolute inset-0"
                  >
                    <DialogueGraph fmfCode={output} brokenLinks={brokenLinks} unreachableNodes={unreachableNodes} warnings={warnings} onNodeEdit={setOutput} />
                  </motion.div>
                )
              ) : (
                <motion.div
                  key="empty-state"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }} 
                  className="h-full flex items-center justify-center text-green-800 text-xl font-bold uppercase tracking-widest py-20"
                >
                  &gt; AWAITING DIRECTIVE...
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>
    </div>
  );
}
