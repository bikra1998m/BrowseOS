//go:build !linux

package main

// Non-Linux: no TUN/NAT — relay stays L2 switch + DHCP only.
func initRelayNAT() string { return "" }

func relayNatEnabled() bool { return false }

func relayNatRegisterIP(_ *rclient, _ string) {}

func relayNatUnregister(_ *rclient) {}

func relayNatTryForward(_ *rclient, _ []byte) bool { return false }

func shutdownRelayNAT() {}
