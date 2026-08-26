// Package webui встраивает статику веб-вьювера audit-логов (index.html +
// app.js, см. static/) в бинарник сервера через go:embed — отдельного
// деплоя фронтенда не требуется (см. README).
package webui

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed static
var files embed.FS

// Handler отдаёт статику вьювера (index.html на "/", app.js на "/app.js").
func Handler() http.Handler {
	sub, err := fs.Sub(files, "static")
	if err != nil {
		panic(err) // сборка гарантирует наличие static/, паника недостижима в runtime
	}
	return http.FileServerFS(sub)
}
