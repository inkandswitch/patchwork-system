// just enough of node's fs, process and path for a GOOS=js go program to
// believe it's on a computer. files live in a map, stdin and stdout are pipes
// to whoever is driving it

type Callback = (error: Error | null, value?: unknown) => void

interface File {
	kind: "file"
	data: Uint8Array
	mtime: number
}

interface Dir {
	kind: "dir"
	mtime: number
}

const S_IFDIR = 0o040000
const S_IFREG = 0o100000

const constants = {
	O_RDONLY: 0,
	O_WRONLY: 1,
	O_RDWR: 2,
	O_CREAT: 64,
	O_EXCL: 128,
	O_TRUNC: 512,
	O_APPEND: 1024,
	O_DIRECTORY: 65536,
}

function oops(code: string, path?: string) {
	return Object.assign(new Error(`${code}${path ? `: ${path}` : ""}`), {
		code,
	})
}

export function resolve(...segments: string[]) {
	let path = ""
	for (let i = segments.length - 1; i >= 0 && !path.startsWith("/"); i--) {
		path = segments[i] + (path ? "/" + path : "")
	}
	const parts: string[] = []
	for (const part of ("/" + path).split("/")) {
		if (!part || part == ".") continue
		if (part == "..") parts.pop()
		else parts.push(part)
	}
	return "/" + parts.join("/")
}

function parent(path: string) {
	return path.slice(0, path.lastIndexOf("/")) || "/"
}

export function createMemFS() {
	const nodes = new Map<string, File | Dir>([
		["/", { kind: "dir", mtime: Date.now() }],
	])
	const fds = new Map<number, { path: string; pos: number; append: boolean }>()
	let nextFd = 3
	let ino = 1
	const inodes = new Map<string, number>()

	const stdin: Uint8Array[] = []
	let waiting: (() => void) | undefined
	let stdout = (_bytes: Uint8Array) => {}
	const decoder = new TextDecoder()
	let stderr = ""

	function stat(path: string) {
		const node = nodes.get(path)
		if (!node) throw oops("ENOENT", path)
		if (!inodes.has(path)) inodes.set(path, ino++)
		const size = node.kind == "file" ? node.data.byteLength : 0
		return {
			dev: 1,
			ino: inodes.get(path),
			mode: node.kind == "dir" ? S_IFDIR | 0o755 : S_IFREG | 0o644,
			nlink: 1,
			uid: 0,
			gid: 0,
			rdev: 0,
			size,
			blksize: 4096,
			blocks: Math.ceil(size / 512),
			atimeMs: node.mtime,
			mtimeMs: node.mtime,
			ctimeMs: node.mtime,
			isDirectory: () => node.kind == "dir",
		}
	}

	function file(path: string) {
		const node = nodes.get(path)
		if (!node) throw oops("ENOENT", path)
		if (node.kind == "dir") throw oops("EISDIR", path)
		return node
	}

	function mkdirp(path: string) {
		if (nodes.get(path)?.kind == "dir") return
		mkdirp(parent(path))
		if (nodes.has(path)) throw oops("ENOTDIR", path)
		nodes.set(path, { kind: "dir", mtime: Date.now() })
	}

	function readStdin(buffer: Uint8Array, offset: number, length: number) {
		let n = 0
		while (n < length && stdin.length) {
			const chunk = stdin[0]
			const take = Math.min(chunk.byteLength, length - n)
			buffer.set(chunk.subarray(0, take), offset + n)
			n += take
			if (take == chunk.byteLength) stdin.shift()
			else stdin[0] = chunk.subarray(take)
		}
		return n
	}

	function writeOut(fd: number, bytes: Uint8Array) {
		if (fd == 1) {
			stdout(bytes.slice())
		} else {
			stderr += decoder.decode(bytes, { stream: true })
			const nl = stderr.lastIndexOf("\n")
			if (nl != -1) {
				console.warn("[tsgo]", stderr.slice(0, nl))
				stderr = stderr.slice(nl + 1)
			}
		}
		return bytes.byteLength
	}

	// every method reports through a node-style callback; go waits on it. later, as node does: a
	// callback made right away runs go inside this call, so the js stack grows by a go turn per
	// call and never unwinds (safari's worker stack runs out while tsgo starts)
	function call(callback: Callback, fn: () => unknown) {
		let value: unknown
		let error: Error | null = null
		try {
			value = fn()
		} catch (e) {
			error = e as Error
		}
		queueMicrotask(() => callback(error, value))
	}

	const fs = {
		constants,
		writeSync(fd: number, buf: Uint8Array) {
			return writeOut(fd, buf)
		},
		open(path: string, flags: number, _mode: number, callback: Callback) {
			call(callback, () => {
				path = resolve(path)
				let node = nodes.get(path)
				if (node && flags & constants.O_CREAT && flags & constants.O_EXCL) {
					throw oops("EEXIST", path)
				}
				if (!node) {
					if (!(flags & constants.O_CREAT)) throw oops("ENOENT", path)
					if (nodes.get(parent(path))?.kind != "dir") {
						throw oops("ENOENT", path)
					}
					node = { kind: "file", data: new Uint8Array(), mtime: Date.now() }
					nodes.set(path, node)
				}
				if (node.kind == "dir" && flags & (constants.O_WRONLY | constants.O_RDWR)) {
					throw oops("EISDIR", path)
				}
				if (node.kind == "file" && flags & constants.O_TRUNC) {
					node.data = new Uint8Array()
					node.mtime = Date.now()
				}
				const fd = nextFd++
				fds.set(fd, {
					path,
					pos: 0,
					append: Boolean(flags & constants.O_APPEND),
				})
				return fd
			})
		},
		close(fd: number, callback: Callback) {
			call(callback, () => {
				fds.delete(fd)
			})
		},
		read(
			fd: number,
			buffer: Uint8Array,
			offset: number,
			length: number,
			position: number | null,
			callback: Callback,
		) {
			if (fd == 0) {
				// park until someone writes to stdin; go keeps running other goroutines
				const attempt = () => {
					if (!stdin.length) {
						waiting = attempt
						return
					}
					waiting = undefined
					callback(null, readStdin(buffer, offset, length))
				}
				return queueMicrotask(attempt)
			}
			call(callback, () => {
				const handle = fds.get(fd)
				if (!handle) throw oops("EBADF")
				const { data } = file(handle.path)
				const start = position ?? handle.pos
				const chunk = data.subarray(start, start + length)
				buffer.set(chunk, offset)
				if (position == null) handle.pos += chunk.byteLength
				return chunk.byteLength
			})
		},
		write(
			fd: number,
			buffer: Uint8Array,
			offset: number,
			length: number,
			position: number | null,
			callback: Callback,
		) {
			call(callback, () => {
				const bytes = buffer.subarray(offset, offset + length)
				if (fd == 1 || fd == 2) return writeOut(fd, bytes)
				const handle = fds.get(fd)
				if (!handle) throw oops("EBADF")
				const node = file(handle.path)
				const start = handle.append ? node.data.byteLength : position ?? handle.pos
				const end = start + bytes.byteLength
				if (end > node.data.byteLength) {
					const grown = new Uint8Array(end)
					grown.set(node.data)
					node.data = grown
				}
				node.data.set(bytes, start)
				node.mtime = Date.now()
				if (position == null) handle.pos = end
				return bytes.byteLength
			})
		},
		fstat(fd: number, callback: Callback) {
			call(callback, () => {
				if (fd <= 2) {
					return { ...stat("/"), mode: 0o020000 | 0o666, isDirectory: () => false }
				}
				const handle = fds.get(fd)
				if (!handle) throw oops("EBADF")
				return stat(handle.path)
			})
		},
		stat(path: string, callback: Callback) {
			call(callback, () => stat(resolve(path)))
		},
		lstat(path: string, callback: Callback) {
			call(callback, () => stat(resolve(path)))
		},
		readdir(path: string, callback: Callback) {
			call(callback, () => {
				path = resolve(path)
				if (nodes.get(path)?.kind != "dir") throw oops("ENOTDIR", path)
				const prefix = path == "/" ? "/" : path + "/"
				const names: string[] = []
				for (const key of nodes.keys()) {
					if (key != path && key.startsWith(prefix)) {
						const rest = key.slice(prefix.length)
						if (!rest.includes("/")) names.push(rest)
					}
				}
				return names
			})
		},
		mkdir(path: string, _perm: number, callback: Callback) {
			call(callback, () => {
				path = resolve(path)
				if (nodes.has(path)) throw oops("EEXIST", path)
				if (nodes.get(parent(path))?.kind != "dir") throw oops("ENOENT", path)
				nodes.set(path, { kind: "dir", mtime: Date.now() })
			})
		},
		rmdir(path: string, callback: Callback) {
			call(callback, () => {
				path = resolve(path)
				if (nodes.get(path)?.kind != "dir") throw oops("ENOTDIR", path)
				for (const key of nodes.keys()) {
					if (key.startsWith(path + "/")) throw oops("ENOTEMPTY", path)
				}
				nodes.delete(path)
			})
		},
		unlink(path: string, callback: Callback) {
			call(callback, () => {
				file(resolve(path))
				nodes.delete(resolve(path))
			})
		},
		rename(from: string, to: string, callback: Callback) {
			call(callback, () => {
				from = resolve(from)
				to = resolve(to)
				const node = nodes.get(from)
				if (!node) throw oops("ENOENT", from)
				nodes.delete(from)
				nodes.set(to, node)
			})
		},
		ftruncate(fd: number, length: number, callback: Callback) {
			call(callback, () => {
				const handle = fds.get(fd)
				if (!handle) throw oops("EBADF")
				const node = file(handle.path)
				node.data = node.data.slice(0, length)
			})
		},
		truncate(path: string, length: number, callback: Callback) {
			call(callback, () => {
				const node = file(resolve(path))
				node.data = node.data.slice(0, length)
			})
		},
		readlink(path: string, callback: Callback) {
			callback(oops("EINVAL", path))
		},
		fsync(_fd: number, callback: Callback) {
			callback(null)
		},
		utimes(path: string, _atime: number, mtime: number, callback: Callback) {
			call(callback, () => {
				const node = nodes.get(resolve(path))
				if (!node) throw oops("ENOENT", path)
				node.mtime = mtime * 1000
			})
		},
		chmod: (_p: string, _m: number, cb: Callback) => cb(null),
		fchmod: (_fd: number, _m: number, cb: Callback) => cb(null),
		chown: (_p: string, _u: number, _g: number, cb: Callback) => cb(null),
		fchown: (_fd: number, _u: number, _g: number, cb: Callback) => cb(null),
		lchown: (_p: string, _u: number, _g: number, cb: Callback) => cb(null),
		link: (_p: string, _l: string, cb: Callback) => cb(oops("ENOSYS")),
		symlink: (_p: string, _l: string, cb: Callback) => cb(oops("ENOSYS")),
	}

	const process = {
		getuid: () => 0,
		getgid: () => 0,
		geteuid: () => 0,
		getegid: () => 0,
		getgroups: () => [0],
		pid: 1,
		ppid: 0,
		umask: () => 0o022,
		cwd: () => "/",
		chdir: () => {},
	}

	const encoder = new TextEncoder()

	return {
		fs,
		process,
		path: { resolve },
		writeFile(path: string, text: string) {
			path = resolve(path)
			mkdirp(parent(path))
			const existing = nodes.get(path)
			nodes.set(path, {
				kind: "file",
				data: encoder.encode(text),
				mtime: Date.now(),
			})
			return existing ? "changed" : "created"
		},
		readFile(path: string) {
			const node = nodes.get(resolve(path))
			return node?.kind == "file" ? decoder.decode(node.data) : undefined
		},
		exists(path: string) {
			return nodes.has(resolve(path))
		},
		remove(path: string) {
			return nodes.delete(resolve(path))
		},
		writeStdin(bytes: Uint8Array) {
			stdin.push(bytes)
			// never call back into go while go might be on the stack
			queueMicrotask(() => waiting?.())
		},
		onStdout(fn: (bytes: Uint8Array) => void) {
			stdout = fn
		},
	}
}

export type MemFS = ReturnType<typeof createMemFS>
