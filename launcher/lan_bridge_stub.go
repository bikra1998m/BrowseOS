//go:build !windows

package main

import "fmt"

func openLANPacketPort() (lanPacketPort, lanHostConfig, error) {
	return nil, lanHostConfig{}, fmt.Errorf("host-LAN bridge is currently available on Windows with Npcap")
}
