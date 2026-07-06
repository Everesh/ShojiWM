# ShojiWM#Utils
### hotreload.sh
simple sentinel that reloads config on file change
#### Prerequisites
- inotify-tools
- ydotool
#### Usage
```TypeScript
// ~/.config/shojiwm/src/index.tsx
COMPOSITOR.process.once("hotreload_sentinel", {
  command: ['path/to/script'],
  runPolicy: "once-per-session",
})
```
