## Repository: neo-os-aa

This is the NeoOS AA (Abstract Account) repository - Neo N3 account abstraction (ERC-4337 equivalent).

Primary responsibilities:
- C03 account: sole authority for account abstraction - user operations, proxy verification, and recovery (protocol-aa-core)
- AA decides whether an actor authorized an operation and nothing more
- SmartAccountV3: deterministic accounts keyed by 20-byte accountId
- Verifier plugin authorization: Web3Auth, TEE, WebAuthn, session keys, multisig
- Hook plugin policy enforcement: daily limits, token restrictions, credential gates
- Backup-owner escape hatch with timelocked verifier rotation
- On-chain paymaster for trustless gasless execution

This repo should NOT:
- Grant DID eligibility, hold network identity, or select signers
- Have dependency on the DID registry - operation-policy layer composes AAAuthorization with independently verified EligibilityProof
- Replace wallet confirmation - relay can package and pay, but cannot authorize on behalf of account
- Make paymaster sponsorship replace the configured verifier or backup-owner witness

# Global Claude Code Rules

## Core Development Principles

### 1. Test-Driven Development (TDD)
- **ALWAYS** write tests BEFORE implementing any feature or fixing any bug
- Tests must be written first and must fail initially
- Implementation should only contain code necessary to make tests pass
- Every function, method, and class must have comprehensive test coverage
- Include unit tests, integration tests, and edge cases
- Tests must be executable and verifiable
- Test coverage must be at least 90% for all code
- Include performance tests for critical paths
- Write tests for both success and failure scenarios

### 2. Document-Driven Development (DDD)
- **ALWAYS** create documentation BEFORE writing code
- Documentation must include:
  - Purpose and problem being solved
  - API design and interfaces
  - Data structures and schemas
  - Error handling strategies
  - Performance considerations
  - Security implications
  - Usage examples with expected outputs
  - Migration guides for breaking changes
  - Deployment instructions
- Documentation must be kept in sync with code changes
- Include inline documentation for complex logic
- API documentation must include request/response examples

### 3. Production-Ready Code Only
- **NO PLACEHOLDERS** of any kind are allowed:
  - No `TODO` comments without immediate implementation
  - No `console.log` for debugging (use proper logging)
  - No hardcoded values (use configuration)
  - No mock data in production code
  - No simplified implementations
  - No stub functions
  - No "coming soon" features
  - No commented-out code
  - No incomplete error handling
  - No assumptions about environment
- All code must be:
  - Fully implemented and functional
  - Properly error handled with specific error types
  - Validated for all inputs
  - Secure by default
  - Performance optimized
  - Thread-safe where applicable
  - Scalable and maintainable

## Completeness Requirements

### 1. Project Structure
- **ALWAYS** create proper project structure:
  - Organized directory structure (src/, tests/, docs/, config/)
  - Configuration files (package.json, tsconfig.json, .env.example, etc.)
  - Build and deployment scripts
  - CI/CD pipeline configurations
  - Docker files when applicable
  - README with setup instructions
  - LICENSE file
  - .gitignore with comprehensive patterns

### 2. Dependencies and Tooling
- Specify exact versions for all dependencies
- Include development dependencies
- Configure linting (ESLint, Prettier, etc.)
- Set up pre-commit hooks
- Configure test runners
- Include build tools configuration
- Set up code coverage tools
- Configure security scanning

### 3. Code Completeness
- Every feature must be 100% complete before moving to next
- All edge cases must be handled
- All promised functionality must work
- No partial implementations
- Complete CRUD operations where applicable
- Full validation for all inputs
- Complete error messages with actionable information
- Graceful degradation for optional features

### 4. Integration Requirements
- Database migrations must be included
- API integrations must handle all response codes
- External service failures must be handled
- Retry logic with exponential backoff
- Circuit breakers for external dependencies
- Health check endpoints
- Monitoring and metrics integration
- Structured logging with correlation IDs

## Correctness Standards

### 1. Algorithm Correctness
- Use proven algorithms and data structures
- Include complexity analysis in comments
- Optimize for both time and space
- Handle all boundary conditions
- Prevent integer overflow/underflow
- Handle floating-point precision issues
- Use appropriate data types

### 2. Concurrency and Threading
- Proper synchronization mechanisms
- Avoid race conditions
- Prevent deadlocks
- Use thread-safe collections
- Implement proper connection pooling
- Handle resource contention
- Use async/await correctly

### 3. Memory Management
- No memory leaks
- Proper resource disposal
- Efficient memory usage
- Cache invalidation strategies
- Prevent stack overflow
- Handle large data sets efficiently
- Implement pagination where needed

### 4. Security Requirements
- Input sanitization on ALL inputs
- SQL injection prevention
- XSS prevention
- CSRF protection
- Proper authentication and authorization
- Secure password hashing (bcrypt, argon2)
- Rate limiting implementation
- Secure session management
- Encryption for sensitive data
- Security headers implementation
- Principle of least privilege

## Professional Standards

### 1. Code Style and Conventions
- Follow language-specific style guides
- Consistent naming conventions
- Proper code organization
- Meaningful commit messages
- Code reviews before merging
- Branch protection rules
- Semantic versioning
- Change logs maintenance

### 2. Error Handling
- Never swallow exceptions
- Specific error types for different scenarios
- User-friendly error messages
- Technical details in logs only
- Proper HTTP status codes
- Stack traces in development only
- Error recovery strategies
- Graceful shutdown handling

### 3. Performance Standards
- Response time under 200ms for APIs
- Database queries optimized with indexes
- Caching strategies implemented
- CDN usage for static assets
- Lazy loading where appropriate
- Connection pooling configured
- Resource limits defined
- Performance monitoring setup

### 4. Monitoring and Observability
- Structured logging with levels
- Distributed tracing setup
- Metrics collection
- Alerting rules defined
- Dashboard creation
- SLA/SLO definitions
- Incident response procedures
- Post-mortem templates

## Implementation Requirements

### Before Writing Any Code:
1. Research and understand the problem domain completely
2. Design the complete system architecture
3. Write comprehensive tests that define expected behavior
4. Create detailed documentation of the feature/fix
5. Design error handling and edge cases
6. Plan for production deployment
7. Consider scalability requirements
8. Review security implications

### Code Quality Standards:
- Proper error handling with specific error types and recovery strategies
- Input validation on all external data
- Secure coding practices (no SQL injection, XSS, etc.)
- Performance considerations (no N+1 queries, proper indexing)
- Proper logging with appropriate log levels
- Configuration management (no hardcoded values)
- Dependency injection where appropriate
- SOLID principles adherence
- DRY (Don't Repeat Yourself) principle
- KISS (Keep It Simple, Stupid) principle
- YAGNI (You Aren't Gonna Need It) principle

### Forbidden Patterns:
- `// TODO: implement later`
- `throw new Error("Not implemented")`
- `return null; // placeholder`
- `// Simplified version`
- `// Mock implementation`
- `console.log()` for debugging
- Hardcoded credentials or URLs
- Empty catch blocks
- Generic error messages
- Synchronous operations for I/O tasks
- Global variables
- Callback hell
- God objects/functions
- Copy-paste programming
- Magic numbers/strings

### Required Patterns:
- Comprehensive error handling with recovery
- Proper async/await usage
- Resource cleanup (close connections, clear timers)
- Input sanitization and validation
- Proper typing (no `any` types in TypeScript)
- Meaningful variable and function names
- Single responsibility principle
- Dependency injection
- Factory patterns for object creation
- Strategy pattern for algorithms
- Observer pattern for events
- Repository pattern for data access

## Database Standards

### 1. Schema Design
- Normalized database design (3NF minimum)
- Proper indexes on all foreign keys
- Composite indexes for common queries
- Constraints at database level
- Proper data types usage
- UUID for distributed systems
- Soft deletes with timestamps
- Audit trails for sensitive data

### 2. Query Optimization
- Explain plan analysis
- Query performance testing
- Avoid N+1 queries
- Use batch operations
- Implement query result caching
- Connection pooling configuration
- Read replicas for scaling
- Database partitioning strategy

## API Standards

### 1. RESTful Design
- Proper HTTP methods usage
- Resource-based URLs
- Consistent naming conventions
- HATEOAS where applicable
- API versioning strategy
- Content negotiation
- Pagination implementation
- Filtering and sorting support

### 2. API Documentation
- OpenAPI/Swagger specification
- Request/response examples
- Error response documentation
- Authentication documentation
- Rate limiting documentation
- Webhook documentation
- SDK generation
- Postman collections

## Testing Standards

### 1. Test Categories
- Unit tests for all functions
- Integration tests for APIs
- End-to-end tests for workflows
- Performance tests
- Security tests
- Chaos engineering tests
- Smoke tests
- Regression tests

### 2. Test Quality
- Tests must be deterministic
- No flaky tests allowed
- Test data factories
- Mock external dependencies
- Test edge cases
- Test error conditions
- Test race conditions
- Test performance boundaries

## Deployment Standards

### 1. Container Requirements
- Multi-stage Docker builds
- Non-root user execution
- Health check endpoints
- Graceful shutdown handling
- Signal handling
- Resource limits defined
- Security scanning
- Minimal base images

### 2. Infrastructure as Code
- All infrastructure in code
- Terraform/CloudFormation templates
- Environment parity
- Secret management
- Backup strategies
- Disaster recovery plans
- Auto-scaling configuration
- Load balancer setup

## Workflow

1. **Research**: Understand problem domain completely
2. **Architecture**: Design complete system
3. **Documentation**: Write complete documentation
4. **Test Design**: Design all test scenarios
5. **Test Implementation**: Write failing tests
6. **Implementation**: Write code to pass tests
7. **Integration**: Integrate with existing systems
8. **Performance**: Optimize and benchmark
9. **Security**: Security audit and fixes
10. **Deployment**: Deploy with monitoring
11. **Verification**: Verify in production

## Enforcement

These rules apply to:
- All new code
- All code modifications
- All bug fixes
- All refactoring tasks
- All documentation updates
- All configuration changes

**ABSOLUTELY NO EXCEPTIONS** without explicit user override stating "ignore Claude rules for this specific task".

## Quality Gates

Before considering any task complete:
1. All tests must pass
2. Code coverage must be >90%
3. No linting errors
4. No security vulnerabilities
5. Performance benchmarks met
6. Documentation updated
7. Code reviewed
8. Deployed successfully

## Continuous Improvement

- Regular dependency updates
- Performance optimization cycles
- Security audit schedules
- Documentation reviews
- Code refactoring sprints
- Technical debt tracking
- Post-mortem analysis
- Knowledge sharing sessions

## Git Commit Standards

### 1. Commit Message Rules
- **NEVER** mention "Claude", "AI", "assistant", or any AI-related terms in commits
- Write commit messages as if a human developer wrote them
- Use conventional commit format: type(scope): description
- Types: feat, fix, docs, style, refactor, test, chore
- Keep subject line under 50 characters
- Use imperative mood ("Add feature" not "Added feature")
- Reference issue numbers when applicable

### 2. Forbidden Git Patterns
- No "Generated by Claude" or similar messages
- No "AI-assisted" mentions
- No assistant attribution
- No automated tool references unless it's a standard dev tool
- No emoji usage in commit messages
- Write commits as a professional developer would

### 3. Example Commit Messages
✅ Good:
- `feat(auth): implement JWT token refresh`
- `fix(api): handle null response in user endpoint`
- `refactor(database): optimize query performance`
- `test(payment): add integration tests for Stripe`

❌ Bad:
- `feat: added feature as requested by user via Claude`
- `fix: AI-generated fix for bug`
- `update: changes made by assistant`
- `🤖 Generated with Claude Code`
