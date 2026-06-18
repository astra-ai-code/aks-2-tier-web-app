variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

variable "project" {
  description = "Project name prefix (lowercase, no special chars)"
  type        = string
  default     = "aks2tier"
}

variable "environment" {
  description = "Environment tag"
  type        = string
  default     = "dev"
}

variable "node_count" {
  description = "Number of AKS worker nodes"
  type        = number
  default     = 2
}

variable "node_vm_size" {
  description = "AKS node VM size"
  type        = string
  default     = "Standard_B2s"
}

variable "db_username" {
  description = "PostgreSQL admin username"
  type        = string
  default     = "sreuser"
}

variable "db_password" {
  description = "PostgreSQL admin password (min 8 chars, must include uppercase, lowercase, number)"
  type        = string
  sensitive   = true
}

variable "db_name" {
  description = "PostgreSQL database name"
  type        = string
  default     = "sredb"
}
