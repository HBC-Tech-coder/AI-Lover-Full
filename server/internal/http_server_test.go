package internal

import (
	"net"
	"testing"
)

func TestHttpServerListenAddress(t *testing.T) {
	tests := []struct {
		name string
		host string
		want string
	}{
		{
			name: "empty host preserves wildcard listener",
			host: "",
			want: ":8080",
		},
		{
			name: "loopback host restricts listener",
			host: "127.0.0.1",
			want: "127.0.0.1:8080",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := NewHttpServer(&HttpServerConfig{
				Host: tt.host,
				Port: "8080",
			})

			if got := server.listenAddress(); got != tt.want {
				t.Fatalf("listenAddress() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHttpServerListenAddressBinding(t *testing.T) {
	tests := []struct {
		name         string
		host         string
		wantLoopback bool
	}{
		{
			name:         "empty host binds wildcard",
			host:         "",
			wantLoopback: false,
		},
		{
			name:         "loopback host binds loopback only",
			host:         "127.0.0.1",
			wantLoopback: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := NewHttpServer(&HttpServerConfig{
				Host: tt.host,
				Port: "0",
			})

			listener, err := net.Listen("tcp", server.listenAddress())
			if err != nil {
				t.Fatalf("net.Listen(%q): %v", server.listenAddress(), err)
			}
			defer listener.Close()

			address, ok := listener.Addr().(*net.TCPAddr)
			if !ok {
				t.Fatalf("listener address type = %T, want *net.TCPAddr", listener.Addr())
			}
			if tt.wantLoopback && !address.IP.IsLoopback() {
				t.Fatalf("listener IP = %s, want loopback", address.IP)
			}
			if !tt.wantLoopback && !address.IP.IsUnspecified() {
				t.Fatalf("listener IP = %s, want wildcard/unspecified", address.IP)
			}
		})
	}
}
