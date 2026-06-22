# Contributing to Carbon DPI

Thank you for your interest in contributing to the Carbon DPI protocol.

## How to Contribute

### Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include as much detail as possible

### Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Ensure all schemas validate (`npm run validate`)
5. Commit with a clear message
6. Submit a pull request

### Adding a New Methodology

1. Create a JSON file in `carbon-dpi-methodologies`: `CUPI-METH-{NNN}-{name}.json`
2. Follow the existing format (Solar PV is the reference)
3. Include real emission factors with authority citations
4. Include a sample calculation trace
5. Submit a pull request with the authority references

### Proposing Spec Changes

1. Open an issue describing the proposed change
2. Reference relevant standards (W3C, Beckn, UNFCCC, etc.)
3. Include example JSON if applicable
4. Discuss in the issue before submitting a PR

## Code of Conduct

Be respectful. Be constructive. Focus on the protocol.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
