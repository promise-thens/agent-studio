export type OperationGateState =
  | 'idle'
  | 'admitting-execution'
  | 'execution-active'
  | 'provider-mutation'
  | 'session-operation'
  | 'shutting-down'

export type OperationLeaseKind =
  'execution-admission' | 'execution-active' | 'provider-mutation' | 'session-operation'

export class OperationGateConflictError extends Error {
  readonly code = 'invalid-state' as const

  constructor(
    readonly requested: Exclude<OperationLeaseKind, 'execution-active'>,
    readonly currentState: OperationGateState
  ) {
    super('当前主进程状态不允许开始该操作。')
    this.name = 'OperationGateConflictError'
  }
}

export interface OperationLease {
  readonly kind: OperationLeaseKind
  isCurrent(): boolean
  release(): boolean
}

export interface ExecutionAdmissionLease extends OperationLease {
  readonly kind: 'execution-admission'
  activate(): OperationLease | null
}

export interface ShutdownLease {
  readonly transactionId: symbol
  readonly previousState: OperationGateState
  isCurrent(): boolean
}

interface Reservation {
  token: symbol
  kind: OperationLeaseKind
}

/**
 * 同步仲裁 execution、Provider mutation、session operation 与不可逆 shutdown。
 * Gate 不排队、不执行异步业务；调用方必须在首个 await 前取得 lease。
 */
export class OperationGate {
  private state: OperationGateState = 'idle'
  private reservation: Reservation | null = null
  private shutdownLease: ShutdownLease | null = null
  private readonly issuedLeases = new WeakSet<OperationLease>()

  getState(): OperationGateState {
    return this.state
  }

  isShuttingDown(): boolean {
    return this.state === 'shutting-down'
  }

  /** 只认可本 Gate 签发且仍持有当前 reservation 的 lease，阻止外部 Gate 身份穿透。 */
  ownsCurrentLease(lease: OperationLease): boolean {
    return this.issuedLeases.has(lease) && lease.isCurrent()
  }

  acquireExecutionAdmission(): ExecutionAdmissionLease {
    const reservation = this.acquire('execution-admission', 'admitting-execution')
    let activated = false
    const lease: ExecutionAdmissionLease = {
      kind: 'execution-admission',
      isCurrent: () => this.isReservationCurrent(reservation),
      release: () => this.releaseReservation(reservation),
      activate: () => {
        if (activated || !this.isReservationCurrent(reservation) || this.isShuttingDown()) {
          return null
        }
        const activeReservation: Reservation = {
          token: Symbol('execution-active'),
          kind: 'execution-active'
        }
        this.reservation = activeReservation
        this.state = 'execution-active'
        activated = true
        return this.createLease(activeReservation)
      }
    }
    this.issuedLeases.add(lease)
    return lease
  }

  acquireProviderMutation(): OperationLease {
    return this.createLease(this.acquire('provider-mutation', 'provider-mutation'))
  }

  acquireSessionOperation(): OperationLease {
    return this.createLease(this.acquire('session-operation', 'session-operation'))
  }

  /** shutdown 是不可逆 latch；重复调用复用同一 transaction。 */
  beginShutdown(): ShutdownLease {
    if (this.shutdownLease) return this.shutdownLease

    const transactionId = Symbol('shutdown')
    const previousState = this.state
    const lease: ShutdownLease = {
      transactionId,
      previousState,
      isCurrent: () => this.shutdownLease?.transactionId === transactionId
    }
    this.shutdownLease = lease
    this.state = 'shutting-down'
    return lease
  }

  private acquire(
    kind: Exclude<OperationLeaseKind, 'execution-active'>,
    state: Exclude<OperationGateState, 'idle' | 'execution-active' | 'shutting-down'>
  ): Reservation {
    if (this.state !== 'idle' || this.reservation || this.shutdownLease) {
      throw new OperationGateConflictError(kind, this.state)
    }
    const reservation = { token: Symbol(kind), kind }
    this.reservation = reservation
    this.state = state
    return reservation
  }

  private createLease(reservation: Reservation): OperationLease {
    const lease: OperationLease = {
      kind: reservation.kind,
      isCurrent: () => this.isReservationCurrent(reservation),
      release: () => this.releaseReservation(reservation)
    }
    this.issuedLeases.add(lease)
    return lease
  }

  private isReservationCurrent(reservation: Reservation): boolean {
    return this.reservation?.token === reservation.token
  }

  private releaseReservation(reservation: Reservation): boolean {
    if (!this.isReservationCurrent(reservation)) return false
    this.reservation = null
    if (!this.shutdownLease) this.state = 'idle'
    return true
  }
}
