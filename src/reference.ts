// Static reference texts, served both as tool output and as MCP resources.

export const EVENT_COMMAND_REFERENCE = `RPG Maker MV event command codes (each list entry is {"code": N, "indent": N, "parameters": [...]}; every list ends with {"code": 0, "indent": 0, "parameters": []}):

MESSAGES
101 Show Text setup: [faceName, faceIndex, background(0 window,1 dim,2 transparent), position(0 top,1 middle,2 bottom)] — followed by one 401 per text line
401 Text line: ["the text"]
102 Show Choices: [["Choice A","Choice B"], cancelType, defaultType, positionType, background] — each branch starts with 402 [index, "text"], cancel branch 403, end 404
103 Input Number: [variableId, digits]
105 Show Scrolling Text: [speed, noFast] — lines follow as 405 ["text"]

FLOW CONTROL
111 Conditional Branch: params vary by first slot — [0, switchId, 0=ON/1=OFF] switch; [1, varId, 0, value, op(0:=,1:>=,2:<=,3:>,4:<,5:!=)] variable vs constant; [2, "A"|"B"|"C"|"D", 0=ON/1=OFF] self switch; [7, gold, op(0:>=,1:<=,2:<)] gold; [8, itemId] party has item — else branch 411, end 412
112 Loop (end 413 Repeat Above), 113 Break Loop, 115 Exit Event Processing
108 Comment: ["first line"] — further lines follow as 408 ["line"]; the engine ignores comments
117 Common Event: [commonEventId]
118 Label: ["name"], 119 Jump to Label: ["name"]
230 Wait: [frames] (60 = 1 second)

GAME PROGRESSION
121 Control Switches: [startId, endId, 0=ON/1=OFF]
122 Control Variables: [startId, endId, operation(0:set,1:add,2:sub,3:mul,4:div,5:mod), operandType(0:constant,1:variable,2:random,3:gameData,4:script), ...operands]
123 Control Self Switch: ["A"|"B"|"C"|"D", 0=ON/1=OFF]
124 Control Timer: [0=start/1=stop, seconds]

PARTY
125 Change Gold: [operation(0 add,1 sub), operandType(0 const,1 var), value] — with operandType 1 the value is a variable id
126 Change Items: [itemId, operation(0 add,1 remove), operandType(0 const,1 var), value]
127/128 Change Weapons/Armors: [id, op(0 add,1 remove), operandType(0 const,1 var), value, includeEquip] — includeEquip true also takes equipped copies when removing
129 Change Party Member: [actorId, 0=add/1=remove, initialize] — initialize (1) resets the actor to their database start when adding; ignored when removing

ACTOR
311 Change HP: [actorType(0 fixed,1 var), actorId, op, operandType, value, allowDeath]
312 Change MP, 313 Change State: [..., 0=add/1=remove, stateId]
314 Recover All: [0, 0] (0 = whole party), 315 Change EXP, 316 Change Level, 317 Change Parameter
318 Change Skill: [actorType, actorId, 0=learn/1=forget, skillId]

MOVEMENT / MAP
201 Transfer Player: [designation(0 direct,1 vars), mapId, x, y, direction(0 retain,2,4,6,8), fadeType]
203 Set Event Location, 204 Scroll Map: [direction, distance, speed]
205 Set Movement Route: [characterId(-1 player,0 this,N eventId), {list: [routeCommand..., {"code":0,"parameters":[]}], repeat, skippable, wait}] — a routeCommand is {code, parameters, indent: null}: 1 down, 2 left, 3 right, 4 up, 14 jump [x,y], 15 wait [frames], 16-19 turn down/left/right/up, 27/28 switch ON/OFF [id], 29 speed [1-6], 30 frequency [1-5], 31/32 walk anim ON/OFF, 33/34 step anim ON/OFF, 35/36 direction fix ON/OFF, 37/38 through ON/OFF, 39/40 transparent ON/OFF. Each route command (not the terminator) is repeated as a 505 row [routeCommand] at the same indent as the 205
211 Change Transparency, 212 Show Animation: [characterId(-1 player,0 this,N eventId), animationId, wait]
213 Show Balloon Icon: [characterId(-1 player,0 this,N eventId), balloonId(1-10), wait]
216 Change Player Followers, 217 Gather Followers

SCREEN
221 Fadeout Screen, 222 Fadein Screen
223 Tint Screen: [[r(-255..255),g,b,gray(0..255)], frames, wait]
224 Flash Screen: [[r(0..255),g,b,intensity(0..255)], frames, wait]
225 Shake Screen: [power(1-9), speed(1-9), frames, wait]
236 Set Weather Effect: ["none"|"rain"|"storm"|"snow", power(1-9), frames, wait]

AUDIO / PICTURES
241 Play BGM / 245 Play BGS / 249 Play ME / 250 Play SE: [{name, volume(0-100), pitch(50-150), pan(-100..100)}] (an empty name stops/clears the channel)
242 Fadeout BGM: [seconds], 246 Fadeout BGS: [seconds], 251 Stop SE
231 Show Picture: [pictureId(1-100), "name", origin(0 upper left,1 center), designation(0 direct), x, y, scaleX(%), scaleY(%), opacity(0-255), blendMode(0 normal,1 add,2 multiply,3 screen)]
232 Move Picture, 235 Erase Picture: [pictureId]

SCENES / BATTLE
301 Battle Processing: [designation(0 direct,1 var,2 random), troopId, canEscape, canLose] — a block like 102/111: optional branches 601 If Win, 602 If Escape (only reachable with canEscape), 603 If Lose (only reachable with canLose), each followed by its body one indent deeper, closed by 604 End of Battle
302 Shop Processing: [goodsType(0 item,1 weapon,2 armor), id, priceType(0 database price,1 custom), price, purchaseOnly] — extra goods rows as 605 [goodsType, id, priceType, price]
303 Name Input Processing: [actorId, maxChars]
351 Open Menu Screen, 352 Open Save Screen, 353 Game Over, 354 Return to Title

ADVANCED
355 Script: ["js line 1"] — continuation lines 655 ["js line N"]
356 Plugin Command: ["CommandName arg1 arg2"]

Event page "trigger": 0 Action Button, 1 Player Touch, 2 Event Touch, 3 Autorun, 4 Parallel.
Event page "priorityType": 0 Below characters, 1 Same as characters, 2 Above characters.`;

export const TRAIT_REFERENCE = `RPG Maker MV trait ("feature") codes. A trait is {"code": N, "dataId": N, "value": N}. Traits live in the "traits" array of actors, classes, weapons, armors, enemies and states.

RATES
11 Element Rate: dataId = element id, value = multiplier (0.5 = takes half damage, 1.5 = weak)
12 Debuff Rate: dataId = param id 0-7, value = multiplier
13 State Rate: dataId = state id, value = multiplier (chance to be afflicted)
14 State Resist: dataId = state id (immune)

PARAMETERS
21 Param (multiplier): dataId 0 MHP, 1 MMP, 2 ATK, 3 DEF, 4 MAT, 5 MDF, 6 AGI, 7 LUK; value = multiplier (1.1 = +10%)
22 Ex-Param (additive): dataId 0 HIT, 1 EVA, 2 CRI, 3 CEV, 4 MEV, 5 MRF, 6 CNT, 7 HRG, 8 MRG, 9 TRG; value = rate added (0.05 = +5%)
23 Sp-Param (multiplier): dataId 0 TGR, 1 GRD, 2 REC, 3 PHA, 4 MCR, 5 TCR, 6 PDR, 7 MDR, 8 FDR, 9 EXR

ATTACK
31 Attack Element: dataId = element id
32 Attack State: dataId = state id, value = chance (0.3 = 30%)
33 Attack Speed: value = added speed
34 Attack Times+: value = extra attacks

SKILLS
41 Add Skill Type: dataId = skill type id, 42 Seal Skill Type
43 Add Skill: dataId = skill id, 44 Seal Skill

EQUIPMENT
51 Equip Weapon Type: dataId = weapon type id, 52 Equip Armor Type: dataId = armor type id
53 Lock Equip: dataId = equip type id, 54 Seal Equip, 55 Slot Type (dataId 1 = dual wield)

OTHER
61 Action Times+: value = chance of an extra action per turn (0.5 = 50%)
62 Special Flag: dataId 0 Auto Battle, 1 Guard, 2 Substitute, 3 Preserve TP
63 Collapse Effect: dataId 0 normal, 1 boss, 2 instant, 3 no disappear
64 Party Ability: dataId 0 Encounter Half, 1 Encounter None, 2 Cancel Surprise, 3 Raise Preemptive, 4 Gold Double, 5 Drop Item Double`;

export const FORMULA_REFERENCE = `RPG Maker MV damage formulas.

A skill/item has damage = {type, elementId, formula, variance, critical}. The formula is a JavaScript expression evaluated by the engine with:
  a  the user (battler), b  the target, v  the game variables (v[1] is variable 1).
Useful properties of a and b: hp, mp, tp, mhp, mmp, atk, def, mat, mdf, agi, luk, level (actors only), plus hit, eva, cri, cev ...
Useful methods: b.isStateAffected(stateId), a.isActor(), a.isEnemy(), Math.max/min/floor/ceil/round/abs/pow/sqrt.

damage.type: 0 none, 1 HP damage, 2 MP damage, 3 HP recover, 4 MP recover, 5 HP drain, 6 MP drain
hitType (skill): 0 certain hit, 1 physical attack, 2 magical attack
damage.variance: percent spread, default 20. damage.critical: whether the skill can crit (crits triple damage).

Evaluation: value = max(formula, 0). Then * element rate (damage.elementId, -1 = the user's attack elements, 0 = none)
  * target PDR (physical) or MDR (magical) * target REC when recovering, * 3 on a critical hit,
  then variance: amp = floor(|value| * variance / 100); value +/- (random(0..amp) + random(0..amp) - amp), rounded.
A formula that throws or returns NaN counts as 0.

Typical formulas:
  Physical attack:      a.atk * 4 - b.def * 2          (the default Attack skill)
  Magic attack:         a.mat * 4 - b.mdf * 2
  Heal:                 a.mat * 2 + 200                 (damage.type 3)
  Percent of max HP:    b.mhp * 0.25                    (damage.type 1)
  Level scaled:         a.level * 10 + a.atk * 2 - b.def
  Bonus vs a state:     a.atk * 3 - b.def * 2 + (b.isStateAffected(4) ? 100 : 0)
  Variable driven:      v[3] * 5
Rule of thumb: ATK/MAT x4 against DEF/MDF x2 gives damage near 2x the user's offence against equal-level targets;
tune by the hits-to-kill you want (see balance_report).`;

export const DATABASE_REFERENCE = `RPG Maker MV database records (data/*.json). Arrays are 1-indexed: index 0 is null and ids equal array positions.

PARAMETER ORDER (params arrays everywhere): [MHP, MMP, ATK, DEF, MAT, MDF, AGI, LUK]

actors:   id, name, nickname, classId, initialLevel, maxLevel, characterName/Index, faceName/Index, battlerName, equips[5], traits[], profile, note
classes:  id, name, params[8][100] (params[paramId][level], levels 1-99; index 0 unused), expParams [base, extra, accelA, accelB], learnings [{level, skillId, note}], traits[], note
skills:   id, name, iconIndex, description, stypeId, scope, occasion, speed, successRate, repeats, tpGain, hitType, animationId, damage{type,elementId,formula,variance,critical}, effects[], mpCost, tpCost, message1/2, requiredWtypeId1/2, note
items:    id, name, iconIndex, description, itypeId (1 regular, 2 key), price, consumable, scope, occasion, speed, successRate, repeats, tpGain, hitType, animationId, damage{}, effects[], note
weapons:  id, name, iconIndex, description, wtypeId, etypeId (always 1), price, params[8] (flat bonuses), animationId, traits[], note
armors:   id, name, iconIndex, description, atypeId, etypeId (2 shield, 3 head, 4 body, 5 accessory), price, params[8], traits[], note
enemies:  id, name, battlerName, battlerHue, params[8] (absolute values), exp, gold, dropItems [{kind (0 none, 1 item, 2 weapon, 3 armor), dataId, denominator}], actions [{skillId, rating (1-10), conditionType, conditionParam1/2}], traits[], note
troops:   id, name, members [{enemyId, x, y, hidden}], pages [{conditions{}, span, list[] (battle event commands)}]
states:   id, name, iconIndex, restriction (0 none, 1 attack enemy, 2 attack anyone, 3 attack ally, 4 cannot move), priority, autoRemovalTiming (0 none, 1 action end, 2 turn end), minTurns, maxTurns, removeByDamage, chanceByDamage, removeAtBattleEnd, removeByWalking, stepsToRemove, traits[], message1-4, note
animations, tilesets (name, mode, tilesetNames[9], flags[8192]), commonEvents (name, trigger 0 none/1 autorun/2 parallel, switchId, list[])

Scope values: 0 none, 1 one enemy, 2 all enemies, 3-6 random enemies, 7 one ally, 8 all allies, 9 one dead ally, 10 all dead allies, 11 user.
Occasion: 0 always, 1 battle only, 2 menu only, 3 never.
Effect codes: 11 recover HP, 12 recover MP, 13 gain TP, 21 add state, 22 remove state, 31 add buff, 32 add debuff, 33 remove buff, 34 remove debuff, 41 special effect, 42 grow (param), 43 learn skill, 44 common event.
Notes support plugin tags like <tag: value>; the engine itself ignores them.`;
