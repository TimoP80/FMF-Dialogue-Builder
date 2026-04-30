import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });

export const fmfSchema = {
    type: Type.OBJECT,
    properties: {
        NPCName: { type: Type.STRING },
        Location: { type: Type.STRING },
        Description: { type: Type.STRING },
        Unknown_Desc: { type: Type.STRING },
        Known_Desc: { type: Type.STRING },
        Detailed_Desc: { type: Type.STRING },
        start_conditions: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    target_node: { type: Type.STRING },
                    condition_string: { 
                        type: Type.STRING, 
                        description: 'The condition format. Example: SSL "local_var(LVAR_Herebefore) == 0" var_param "" eval -1 value_to_check "" ini_index 6 link 0' 
                    }
                }
            }
        },
        nodes: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING, description: 'Node ID, e.g., Node_Intro' },
                    notes: { type: Type.STRING },
                    is_wtg: { type: Type.BOOLEAN },
                    text: { type: Type.STRING, description: 'NPC dialogue text' },
                    options: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                intField: { type: Type.NUMBER, description: 'Player INT requirement, e.g. 4 for normal' },
                                reaction: { type: Type.STRING, description: 'e.g. REACTION_NEUTRAL' },
                                playertext: { type: Type.STRING, description: 'Player response option' },
                                linkto: { type: Type.STRING, description: 'Target node name exactly matching a node ID, or "done", or "combat"' },
                                notes: { type: Type.STRING }
                            }
                        }
                    }
                }
            }
        }
    }
};

export async function generateDialogueJSON(prompt: string, maxNodes: number = 5, maxOptions: number = 4) {
    const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `Create a branching NPC dialogue tree for a classic RPG game based on this prompt: "${prompt}". 
        Make sure the tree has multiple nodes that interlink securely. The 'linkto' field in each option MUST exactly match the 'name' of an existing node. Valid alternative values are "done" to exit the conversation, or "combat" to initiate combat. Target around ${maxNodes} nodes and up to ${maxOptions} player options per node. Ensure no option links to a non-existent node.`,
        config: {
            responseMimeType: "application/json",
            responseSchema: fmfSchema,
            temperature: 0.7
        }
    });

    return JSON.parse(response.text?.trim() || "{}");
}

export function fmfToString(data: any): string {
    let out = `/*

    Fan Made Fallout Dialogue Tool
         dialogue script file

 -- hand editing this file is not recommended

 Created with version 0.27.3-beta

*/\n\n`;

    out += `NPCName "${data.NPCName || 'Unknown NPC'}"\n`;
    out += `Location "${data.Location || 'Unknown Location'}"\n`;
    out += `Description "${data.Description || ''}"\n`;
    out += `Unknown_Desc "${data.Unknown_Desc || 'You see someone.'}"\n`;
    out += `Known_Desc "${data.Known_Desc || 'You see someone you know.'}"\n`;
    out += `Detailed_Desc "${data.Detailed_Desc || 'They look interesting.'}"\n`;
    
    out += `/* Dialogue starting conditions */\n\n`;
    out += `start_conditions\n`;
    out += `default_condition -1\n{\n`;
    if (data.start_conditions && data.start_conditions.length > 0) {
        let conds = data.start_conditions.map((sc: any) => {
            return `cond target_node "${sc.target_node}"\n{\n    ${sc.condition_string}\n}`;
        }).join(",\n");
        out += conds + "\n";
    }
    out += `};\n\n`;
    
    out += `/* Regular nodes */\n\n`;
    if (data.nodes && data.nodes.length > 0) {
        for (const node of data.nodes) {
            out += `Node "${node.name}"\n`;
            out += `notes "${node.notes || ''}"\n`;
            out += `is_wtg = ${node.is_wtg ? 'true' : 'false'}\n`;
            out += `{\n`;
            // Escape quotes inside NPCText
            let safeText = (node.text || '').replace(/"/g, '\\"');
            out += `NPCText "${safeText}"\n`;
            out += `      options {\n`;
            if (node.options && node.options.length > 0) {
                for (const opt of node.options) {
                    let safePlayerText = (opt.playertext || '').replace(/"/g, '\\"');
                    out += `          int=${opt.intField ?? 4} Reaction=${opt.reaction || 'REACTION_NEUTRAL'} playertext "${safePlayerText}" linkto "${opt.linkto}"  notes "${opt.notes || ''}"\n`;
                }
            }
            out += `              }\n`;
            out += `}\n`;
        }
    }
    
    return out;
}
