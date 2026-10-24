import { MemoryMailboxTable } from '../src/MemoryMailboxTable'
import { defineMailboxTableContract } from './mailbox-table.contract'

defineMailboxTableContract('MemoryMailboxTable', MemoryMailboxTable.make)
