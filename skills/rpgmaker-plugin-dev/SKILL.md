---
name: rpgmaker-plugin-dev
description: Creating and editing RPG Maker MV plugins with the rpgmaker-mv MCP server - header format, parameters, safe aliasing of engine methods and plugin commands. Use when adding or changing files in js/plugins.
---

# Plugin development

## Tools
`list_plugins`, `read_plugin`, `create_plugin` (scaffold), `write_plugin` (replace the source), `configure_plugin` (set parameters, enable/disable), `add_plugin` / `remove_plugin` (register in `js/plugins.js`), then `playtest_start` and `playtest_log` to see console errors (NW.js mode).

## File header
The editor reads parameters from a comment block at the top of the file:

```js
//=============================================================================
// MyPlugin.js
//=============================================================================
/*:
 * @plugindesc One line shown in the plugin manager.
 * @author Name
 *
 * @param Speed
 * @desc What this parameter does.
 * @default 4
 *
 * @help
 * Describe plugin commands and usage here.
 */
```

The file name and the registered plugin name must match exactly. Plugin parameters are strings: convert with `Number(...)` or `JSON.parse`.

## Pattern for changing engine behaviour
Never edit `js/rpg_*.js`. Alias the original method and call it:

```js
(function() {
  var params = PluginManager.parameters('MyPlugin');
  var speed = Number(params['Speed'] || 4);

  var _Game_Player_initialize = Game_Player.prototype.initialize;
  Game_Player.prototype.initialize = function() {
    _Game_Player_initialize.call(this);
    this.setMoveSpeed(speed);
  };
})();
```

Always wrap code in an IIFE, keep aliases in local variables and call the original unless you intend to replace it.

## Plugin commands

```js
var _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
Game_Interpreter.prototype.pluginCommand = function(command, args) {
  _Game_Interpreter_pluginCommand.call(this, command, args);
  if (command === 'MyCommand') { /* args are the space-separated words */ }
};
```

Events call it with event command 356: `parameters: ["MyCommand arg1 arg2"]`.

## Order and testing
- Plugin order matters: plugins that alias the same method wrap each other in load order. `list_plugins` shows the order.
- After writing, `playtest_start` in NW.js mode and read `playtest_log` for `ReferenceError`/`TypeError`. A black screen at startup is almost always a plugin error.
- Use `configure_plugin` for parameters instead of editing `js/plugins.js` by hand.
- MV runs in NW.js with its own JavaScript engine version: avoid syntax newer than the project's runtime supports unless you have verified it.
