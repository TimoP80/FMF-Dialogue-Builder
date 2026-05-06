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
        },
        custom_procedures: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING, description: 'Name of the custom procedure' },
                    associate_node_name: { type: Type.STRING, description: 'The name of the node this procedure is associated with' },
                    code: { type: Type.STRING, description: 'The code of the custom procedure, e.g. "debug_msg(\\\"Test\\\");"' }
                }
            }
        },
        skill_checks: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING, description: 'Name of the skill check, e.g. Skill_Check_000_Speech' },
                    associate_node_name: { type: Type.STRING, description: 'The name of the node this skill check is associated with' },
                    skill_num: { type: Type.INTEGER, description: 'The skill number/identifier (e.g. 15 for Speech)' },
                    difficulty_modifier: { type: Type.INTEGER, description: 'The difficulty modifier (e.g. 12)' },
                    onsuccess: { type: Type.STRING, description: 'Node name to go to on success' },
                    onfailure: { type: Type.STRING, description: 'Node name to go to on failure' }
                }
            }
        }
    }
};

export async function generateDialogueJSON(prompt: string, theme: string = "", tone: string = "", keyCharacters: string = "", maxNodes: number = 5, maxOptions: number = 4, aiModel: string = "gemini-2.5-flash", customGvars: string[] = []) {
    const extraGvarsContext = customGvars.length > 0
        ? `\n13. Use these custom GVARs as needed for state management: ${customGvars.join(', ')}.`
        : '';
        
    const response = await ai.models.generateContent({
        model: aiModel,
        contents: `You are an expert game designer writing dialogue for a classic RPG.
Create a branching NPC dialogue tree based on this scenario/prompt: "${prompt}".

Additional Parameters:
- Theme: ${theme || 'Any'}
- Tone: ${tone || 'Standard'}
- Key Characters: ${keyCharacters || 'NPC'}

CRITICAL CONSTRAINTS:
1. Generate approximately ${maxNodes} unique dialogue nodes.
2. Provide up to ${maxOptions} response options per node.
3. Every single 'linkto' field MUST exactly match the 'name' field of one of the nodes you define, OR be "done" (to exit the conversation), OR be "combat" (to start a fight).
4. NEVER use a 'linkto' value that does not exist in the 'nodes' array.
5. The 'target_node' in 'start_conditions' must point to your initial dialogue node.
6. Check that all generated nodes (except the starting one) are reachable from another node's option. Do not generate isolated nodes.
7. Keep names simple (e.g. Node_Intro, Node_AskRumor) to avoid spelling mistakes in linkto fields.
8. Feel free to generate 'custom_procedures' if special scripting logic is needed (like giving items or xp), associating them with specific node names.
9. You can also generate 'skill_checks' if an option or node requires a skill check, associating them with specific node names.
10. You can use standard Fallout/FanMadeFallout item PIDs like PID_STIMPAK, PID_10MM_PISTOL, PID_JET, PID_BOTTLE_CAPS, PID_KNIFE, etc. in custom_procedures if items are given or taken.
11. You can use command macros from command.h in custom_procedures: dude_is_male, dude_cur_hits, self_item, dude_caps, dude_has_car, floater, skill_success, etc.
12. You can manipulate global variables in custom_procedures using global_var(GVAR_NAME) and set_global_var(GVAR_NAME, value).${extraGvarsContext}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: fmfSchema,
            temperature: 0.4
        }
    });

    const text = response.text?.trim() || "{}";
    const cleanText = text.replace(/^```(json)?/, '').replace(/```$/, '').trim();
    return JSON.parse(cleanText);
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
    let nodeIndexMap: Record<string, number> = {};
    if (data.nodes && data.nodes.length > 0) {
        for (let idx = 0; idx < data.nodes.length; idx++) {
            const node = data.nodes[idx];
            nodeIndexMap[node.name] = idx;
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
    
    if (data.custom_procedures && data.custom_procedures.length > 0) {
        out += `\n/* Custom procedures */\n`;
        for (const proc of data.custom_procedures) {
            const nodeIdx = nodeIndexMap[proc.associate_node_name] ?? 0;
            // Un-escape quotes and wrap in quotes appropriately
            let procCode = proc.code || '';
            if (!procCode.trim().startsWith('"')) {
                // simple quote formatting
                procCode = `"${procCode.replace(/"/g, '\\"')}"`;
            }
            out += `      custom_proc ${proc.name} associate_node ${nodeIdx} {\n`;
            out += `      ${procCode}\n`;
            out += `      }\n`;
        }
    }
    
    if (data.skill_checks && data.skill_checks.length > 0) {
        for (const sc of data.skill_checks) {
            out += `\n/* Skill checks for node ${sc.associate_node_name} */\n\n`;
            out += `      define_skill_check ${sc.name} {\n`;
            out += `      skill_num = ${sc.skill_num};\n`;
            out += `      difficulty_modifier = ${sc.difficulty_modifier};\n`;
            out += `      onsuccess => ${sc.onsuccess};\n`;
            out += `      onfailure => ${sc.onfailure};\n`;
            out += `      }\n`;
        }
    }
    
    return out;
}
