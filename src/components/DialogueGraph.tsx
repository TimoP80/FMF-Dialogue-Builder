import { useEffect, useState, useCallback } from 'react';
import ReactFlow, {
  Controls,
  Background,
  Edge,
  Node,
  MarkerType,
  Position,
  useNodesState,
  useEdgesState,
  Panel
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const nodeWidth = 280;
const nodeHeight = 120; // Increased to ensure labels fit comfortably

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction = 'TB') => {
  dagreGraph.setGraph({ rankdir: direction });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      targetPosition: direction === 'LR' ? Position.Left : Position.Top,
      sourcePosition: direction === 'LR' ? Position.Right : Position.Bottom,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
      style: {
        ...node.style,
        width: nodeWidth,
      }
    };
  });

  return { nodes: layoutedNodes, edges };
};

export function parseFMFToGraph(fmfCode: string, brokenLinks: Set<string> = new Set(), unreachableNodes: Set<string> = new Set(), warnings: string[] = []) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const cycleNodes = new Set<string>();
  warnings.forEach(w => {
    if (w.startsWith('Cycle detected: ')) {
      const cyclePart = w.substring('Cycle detected: '.length);
      const parts = cyclePart.split(' -> ');
      parts.forEach(p => cycleNodes.add(p));
    }
  });

  if (!fmfCode) return { nodes, edges };

  // 1. Add pseudo Start node
  const startHasBrokenLinks = Array.from(fmfCode.matchAll(/cond target_node "([^"]+)"/g)).some(m => brokenLinks.has(m[1]));
  nodes.push({
    id: 'START_CONDITIONS',
    data: { label: 'Sys_Init' },
    position: { x: 0, y: 0 },
    style: { 
        background: startHasBrokenLinks ? '#1a0505' : '#0a170a', 
        color: startHasBrokenLinks ? '#ef4444' : '#1ce233', 
        border: startHasBrokenLinks ? '2px dashed #ef4444' : '2px solid #1ce233', 
        borderRadius: '0px', 
        padding: '12px', 
        fontWeight: 'bold', 
        fontFamily: 'VT323, monospace', 
        textTransform: 'uppercase', 
        letterSpacing: '0.1em' 
    }
  });

  // Parse start conditions
  const condRegex = /cond target_node "([^"]+)"/g;
  let match;
  while ((match = condRegex.exec(fmfCode)) !== null) {
      edges.push({
          id: `start-${match[1]}`,
          source: 'START_CONDITIONS',
          target: match[1],
          label: 'Starts Here',
          animated: true,
          style: { stroke: '#1ce233' },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#1ce233' },
      });
  }

  // Parse nodes splitting by 'Node "'
  const chunks = fmfCode.split('Node "').slice(1);
  for (const chunk of chunks) {
      const idMatch = chunk.match(/^([^"]+)"/);
      if(!idMatch) continue;
      const nodeId = idMatch[1];
      
      const npcTextMatch = chunk.match(/NPCText\s+("(?:[^"\\]|\\.)*")/);
      let npcText = '';
      if (npcTextMatch) {
          try {
              npcText = JSON.parse(npcTextMatch[1]);
          } catch (e) {
              npcText = npcTextMatch[1].replace(/(^"|"$)/g, '');
          }
      }

      // Parse options preview for highlighting
      let hasBrokenLinks = false;
      const optionsMatchPreview = chunk.match(/options\s*\{([\s\S]*?)\}/);
      if (optionsMatchPreview) {
          const links = Array.from(optionsMatchPreview[1].matchAll(/linkto\s+"([^"]+)"/g));
          hasBrokenLinks = links.some(m => brokenLinks.has(m[1]));
      }
      const inCycle = cycleNodes.has(nodeId);
      const isUnreachable = unreachableNodes.has(nodeId);

      const nodeData = { 
          id: nodeId,
          npcText,
          options: [] as {text: string, linkto: string, rawPrefix: string, rawSuffix: string}[],
          chunk
      };

      // Parse options
      const optionsMatch = chunk.match(/options\s*\{([\s\S]*?)\}/);
      if (optionsMatch) {
          const optionsStr = optionsMatch[1];
          const optRegex = /(int=\d+\s+Reaction=\w+\s+)playertext\s+("(?:[^"\\]|\\.)*")\s+linkto\s+"([^"]+)"(\s+notes\s+"(?:[^"\\]|\\.)*")?/g;
          let optMatch;
          let i = 0;
          while((optMatch = optRegex.exec(optionsStr)) !== null) {
              const prefix = optMatch[1];
              const pTextRaw = optMatch[2];
              const suffix = optMatch[4] || '';
              let pText = '';
              try {
                  pText = JSON.parse(pTextRaw);
              } catch (e) {
                  pText = pTextRaw.replace(/(^"|"$)/g, '');
              }
              const target = optMatch[3];
              
              nodeData.options.push({
                  text: pText,
                  linkto: target,
                  rawPrefix: prefix,
                  rawSuffix: suffix
              });

              edges.push({
                  id: `e-${nodeId}-${target}-${i++}`,
                  source: nodeId,
                  target: target,
                  label: pText.length > 25 ? pText.substring(0, 25) + '...' : pText,
                  style: { stroke: 'rgba(28, 226, 51, 0.6)' },
                  labelStyle: { fill: '#1ce233', fontSize: 10, fontFamily: 'VT323, monospace' },
                  labelBgStyle: { fill: '#050a05', stroke: 'rgba(28, 226, 51, 0.4)', rx: 0, ry: 0 },
                  markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(28, 226, 51, 0.6)' },
              });

              // Add pseudo target nodes if missing
              if (!nodes.find(n => n.id === target) && target !== nodeId) {
                 if (target === 'done' || target === 'combat') {
                     nodes.push({
                         id: target,
                         data: { label: target === 'done' ? 'EXIT_SYS' : 'INIT_COMBAT', isPseudo: true },
                         position: { x: 0, y: 0 },
                         style: { 
                             background: target === 'done' ? '#020602' : '#1a0505', 
                             color: target === 'done' ? '#1ce233' : '#ef4444', 
                             border: target === 'done' ? '2px solid #1ce233' : '2px dashed #ef4444',
                             borderRadius: '0px', 
                             padding: '12px', 
                             fontWeight: 'bold',
                             fontFamily: 'VT323, monospace',
                             width: nodeWidth
                         }
                     });
                 }
              }
          }
      }

      nodes.push({
          id: nodeId,
          className: isUnreachable ? 'opacity-50 grayscale' : '',
          data: { 
               ...nodeData,
               label: 
              <div className="flex flex-col gap-1 text-left break-words">
                  <span className={`text-[10px] font-mono tracking-wider ${inCycle ? 'text-amber-600' : (hasBrokenLinks ? 'text-red-700' : 'text-green-700')}`}>[{nodeId}]</span>
                  <span className={`text-xs font-bold italic line-clamp-3 ${inCycle ? 'text-amber-400' : (hasBrokenLinks ? 'text-red-400' : 'text-green-400')}`}>"{npcText}"</span>
              </div> 
          },
          position: { x: 0, y: 0 },
          style: {
            background: inCycle ? '#1a1005' : (hasBrokenLinks ? '#1a0505' : '#050a05'),
            color: inCycle ? '#f59e0b' : (hasBrokenLinks ? '#ef4444' : (isUnreachable ? '#6b7280' : '#1ce233')),
            border: inCycle ? '2px dashed #f59e0b' : (hasBrokenLinks ? '2px dashed #ef4444' : (isUnreachable ? '2px dotted #6b7280' : '2px solid rgba(28, 226, 51, 0.4)')),
            borderRadius: '0px',
            padding: '12px',
            fontFamily: 'VT323, monospace'
          }
      });
  }

  // Parse skill checks
  const skillCheckRegex = /define_skill_check\s+(\w+)\s*\{([^}]*)\}/g;
  let scMatch;
  while ((scMatch = skillCheckRegex.exec(fmfCode)) !== null) {
      const scName = scMatch[1];
      const propsStr = scMatch[2];
      
      const onsuccMatch = propsStr.match(/onsuccess\s*=>\s*([\w_]+)/);
      const onfailMatch = propsStr.match(/onfailure\s*=>\s*([\w_]+)/);
      
      if (onsuccMatch) {
          edges.push({
              id: `e-${scName}-succ`,
              source: scName,
              target: onsuccMatch[1],
              label: 'Success',
              style: { stroke: 'rgba(59, 130, 246, 0.6)', strokeDasharray: '5,5' },
              labelStyle: { fill: '#3b82f6', fontSize: 10, fontFamily: 'VT323, monospace' },
              labelBgStyle: { fill: '#050a1a', stroke: 'rgba(59, 130, 246, 0.4)', rx: 0, ry: 0 },
              markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(59, 130, 246, 0.6)' },
          });
      }
      
      if (onfailMatch) {
          edges.push({
              id: `e-${scName}-fail`,
              source: scName,
              target: onfailMatch[1],
              label: 'Failure',
              style: { stroke: 'rgba(239, 68, 68, 0.6)', strokeDasharray: '5,5' },
              labelStyle: { fill: '#ef4444', fontSize: 10, fontFamily: 'VT323, monospace' },
              labelBgStyle: { fill: '#1a0505', stroke: 'rgba(239, 68, 68, 0.4)', rx: 0, ry: 0 },
              markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(239, 68, 68, 0.6)' },
          });
      }

      nodes.push({
          id: scName,
          data: { label: `SKILL CHECK\n[${scName}]`, isPseudo: true },
          position: { x: 0, y: 0 },
          style: { 
              background: '#050a1a', 
              color: '#3b82f6', 
              border: '2px solid #3b82f6',
              borderRadius: '0px', 
              padding: '12px', 
              fontWeight: 'bold',
              fontFamily: 'VT323, monospace',
              width: nodeWidth
          }
      });
  }

  // Remove missing nodes that standard options might link to mistakenly except for done/combat
  const existingNodeIds = new Set(nodes.map(n => n.id));
  const validEdges = edges.map(e => {
    if (!existingNodeIds.has(e.target)) {
        // If node doesn't exist, create an ERROR pseudo-node so graph doesn't crash
        nodes.push({
            id: e.target,
            data: { label: 'ERR_NULL_LINK: ' + e.target },
            position: { x: 0, y: 0 },
            style: { 
                background: '#1a0505', 
                color: '#ef4444', 
                border: '2px dashed #ef4444',
                borderRadius: '0px', 
                padding: '12px', 
                width: nodeWidth,
                fontFamily: 'VT323, monospace',
            }
        });
        existingNodeIds.add(e.target);
        return {
            ...e,
            style: { stroke: '#ef4444', strokeWidth: 2, strokeDasharray: '5,5' },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#ef4444' },
        };
    }
    return e;
  });

  return { nodes, edges: validEdges };
}

function NodeEditorPanel({ node, onClose, onUpdate }: { node: any, onClose: () => void, onUpdate: (nodeId: string, npcText: string, options: any[]) => void }) {
    const [npcText, setNpcText] = useState(node.data.npcText || '');
    const [options, setOptions] = useState([...(node.data.options || [])]);

    useEffect(() => {
        setNpcText(node.data.npcText || '');
        setOptions([...(node.data.options || [])]);
    }, [node.data.chunk]); // Update local state when the underlying chunk changes externally

    return (
        <div className="absolute top-4 left-4 w-80 bg-black/95 border-2 border-green-500 p-4 font-mono z-10 flex flex-col gap-4 text-green-400 max-h-[calc(100%-2rem)] overflow-y-auto crt-effect">
            <div className="flex justify-between items-center border-b-2 border-green-500/50 pb-2">
                <h3 className="font-bold tracking-widest uppercase">Edit Node: [{node.id}]</h3>
                <button onClick={onClose} className="text-red-500 hover:text-red-400 font-bold px-2">&times;</button>
            </div>
            
            <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-widest text-green-600">NPC Text</label>
                <textarea 
                    className="bg-[#0a170a] border border-green-500/30 p-2 text-sm text-green-300 resize-y min-h-[80px] focus:outline-none focus:border-green-500"
                    value={npcText}
                    onChange={(e) => {
                        setNpcText(e.target.value);
                        onUpdate(node.id, e.target.value, options);
                    }}
                />
            </div>

            <div className="flex flex-col gap-3">
                <label className="text-xs uppercase tracking-widest text-green-600">Options</label>
                {options.map((opt: any, idx: number) => (
                    <div key={idx} className="flex flex-col gap-2 p-2 border border-green-500/20 bg-[#020602]">
                        <input 
                            className="bg-transparent border-b border-green-500/30 p-1 text-sm text-green-200 focus:outline-none focus:border-green-500"
                            value={opt.text}
                            onChange={(e) => {
                                const newOpts = [...options];
                                newOpts[idx] = { ...newOpts[idx], text: e.target.value };
                                setOptions(newOpts);
                                onUpdate(node.id, npcText, newOpts);
                            }}
                            placeholder="Player response"
                        />
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-green-700">linkto</span>
                            <input 
                                className="bg-transparent border-b border-green-500/30 p-1 text-xs text-amber-300 flex-1 focus:outline-none focus:border-green-500"
                                value={opt.linkto}
                                onChange={(e) => {
                                    const newOpts = [...options];
                                    newOpts[idx] = { ...newOpts[idx], linkto: e.target.value };
                                    setOptions(newOpts);
                                    onUpdate(node.id, npcText, newOpts);
                                }}
                                placeholder="Target node ID"
                            />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default function DialogueGraph({ fmfCode, brokenLinks, unreachableNodes, warnings, onNodeEdit }: { fmfCode: string, brokenLinks?: Set<string>, unreachableNodes?: Set<string>, warnings?: string[], onNodeEdit?: (code: string) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    // Only parse if code changes
    const timer = setTimeout(() => {
        const { nodes: initialNodes, edges: initialEdges } = parseFMFToGraph(fmfCode, brokenLinks, unreachableNodes, warnings);
        
        // Ensure selectedNodeId still exists
        if (selectedNodeId && !initialNodes.find(n => n.id === selectedNodeId)) {
            setSelectedNodeId(null);
        }

        if (initialNodes.length === 0) {
            setNodes([]);
            setEdges([]);
            return;
        }

        const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
          initialNodes,
          initialEdges,
          'TB'
        );

        setNodes(layoutedNodes);
        setEdges(layoutedEdges);
    }, 100); // small debounce

    return () => clearTimeout(timer);
  }, [fmfCode, brokenLinks, unreachableNodes, warnings, setNodes, setEdges]);

  const onNodeClick = useCallback((_, node: Node) => {
    if (node.id === 'START_CONDITIONS' || node.data?.isPseudo || node.id.startsWith('ERR_NULL_LINK:')) {
        setSelectedNodeId(null);
        return;
    }
    setSelectedNodeId(node.id);
  }, []);

  const selectedNode = nodes.find(n => n.id === selectedNodeId);

  if (!fmfCode) {
    return null;
  }

  const handleUpdateNode = (nodeId: string, newNpcText: string, newOptions: any[]) => {
      if (!onNodeEdit || !selectedNode) return;
      const chunk = selectedNode.data.chunk;
      const startIndex = fmfCode.indexOf(chunk);
      if (startIndex === -1) return;
      const endIndex = startIndex + chunk.length;

      const before = fmfCode.substring(0, startIndex);
      const after = fmfCode.substring(endIndex);

      // Reconstruct the chunk
      let safeNpcText = newNpcText.replace(/"/g, '\\"');
      let newOptionsStr = newOptions.map(opt => {
          let safePText = opt.text.replace(/"/g, '\\"');
          return `          ${opt.rawPrefix}playertext "${safePText}" linkto "${opt.linkto}"${opt.rawSuffix ? ` notes "${opt.rawSuffix}"` : ''}`;
      }).join('\n');

      // The original chunk might have dynamic notes or other things.
      // We will just replace NPCText and the options block.
      
      let newChunk = chunk.replace(/NPCText\s+("(?:[^"\\]|\\.)*")/, `NPCText "${safeNpcText}"`);
      
      // replace options block
      newChunk = newChunk.replace(/options\s*\{([\s\S]*?)\}/, `options {\n${newOptionsStr}\n              }`);

      onNodeEdit(before + newChunk + after);
  };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={() => setSelectedNodeId(null)}
        fitView
        className="bg-[#050a05]"
        minZoom={0.1}
        connectionLineStyle={{ stroke: '#1ce233' }}
      >
        <Background color="rgba(28, 226, 51, 0.15)" gap={16} />
        <Controls className="!bg-black !border-green-500/40 opacity-70 hover:opacity-100 transition-opacity" />
        <Panel position="top-right" className="bg-black/90 px-3 py-1.5 text-xs text-green-500 border-2 border-green-500/40 font-mono tracking-widest uppercase">
          Hold Space to Pan &bull; Drag nodes
        </Panel>
      </ReactFlow>

      {selectedNode && !selectedNode.data.isPseudo && (
          <NodeEditorPanel 
              node={selectedNode}
              onClose={() => setSelectedNodeId(null)}
              onUpdate={handleUpdateNode}
          />
      )}
    </div>
  );
}
